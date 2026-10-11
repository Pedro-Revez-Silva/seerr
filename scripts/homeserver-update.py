#!/usr/bin/env python3
"""Install only verified fork commits; isolate startup, then back up and roll back."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request

REPO = 'Pedro-Revez-Silva/seerr'
BRANCH = 'feature/homeserver-audio-policy'


def run(*args, cwd=None, capture=False):
    return subprocess.run(args, cwd=cwd, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def api(path):
    req = urllib.request.Request('https://api.github.com/' + path,
                                 headers={'User-Agent': 'seerr-homeserver-updater', 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def scratch_directory():
    docker = shutil.which('docker')
    # Docker's Snap cannot read hidden home directories, including .cache.
    # Its own disk-backed cache is accessible to both buildx and bind mounts.
    if docker and (str(Path(docker)).startswith('/snap/') or Path(docker).resolve().name == 'snap'):
        root = Path.home() / 'snap/docker/common/agent-tmp'
    else:
        root = Path(os.environ.get('TMPDIR', Path.home() / '.cache/agent-tmp'))
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.environ['TMPDIR'] = str(root)
    return root


SMOKE = r'''
const fs = require('fs');
const {decideMovieAudio} = require('/app/dist/lib/movieAudioPolicy');
const s = JSON.parse(fs.readFileSync('/app/config/settings.json', 'utf8'));
// Verify the implementation independently of the user's editable choices.
const server = {id:0,isDefault:true,is4k:false};
const policy = {enabled:true,kidsMode:'family',ageCutoff:12,
 profiles:[{radarrServiceId:0,kidsProfileId:7,originalProfileId:8}],
 exceptions:[{tmdbId:803796,preference:'pt-PT',note:'Smoke fixture'}]};
if (s.movieAudio?.enabled) {
 for (const server of s.radarr.filter(r => r.isDefault)) {
  const mapping = s.movieAudio.profiles.find(p => p.radarrServiceId === server.id);
  if (!mapping || mapping.kidsProfileId === mapping.originalProfileId)
   throw new Error('Configured audio profiles are invalid');
 }
}
const movie = (id, age) => ({id, genres:[{id:16}], release_dates:{results:[{iso_3166_1:'PT',release_dates:age == null ? [] : [{certification:`M/${age}`}]}]}});
for (const [id, age, expected] of [[1084244,6,'pt-PT'],[157336,12,'original'],[803796,null,'pt-PT'],[999999999,null,'review']]) {
 const d = decideMovieAudio(movie(id,age),policy,[server],{serverId:server.id});
 if (d.preference !== expected) throw new Error(`Audio smoke test failed: ${id}`);
}
fetch('http://127.0.0.1:5055/api/v1/status?checkUpdateAvailable=false')
 .then(r => {if(!r.ok) throw new Error('Server unhealthy'); return r.json()})
 .then(s => console.log(JSON.stringify({version:s.version,audio:'verified'})))
 .catch(e => {console.error(e.message);process.exit(1)});
'''


def wait_healthy(container):
    for _ in range(45):
        result = subprocess.run(['docker', 'exec', container, 'node', '-e', SMOKE],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        if result.returncode == 0:
            print(result.stdout.strip(), flush=True)
            return
        time.sleep(2)
    raise RuntimeError('Container startup/audio verification failed')


def deploy(image, compose, scratch_root, backup_root, policy=None):
    config = compose.parent / 'config'
    backup_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = time.strftime('%Y%m%d-%H%M%S')
    backup = backup_root / stamp
    backup.mkdir(mode=0o700)
    shutil.copy2(compose, backup / compose.name)
    network = 'seerr-update-isolated'
    candidate = 'seerr-update-check'
    with tempfile.TemporaryDirectory(prefix='seerr-staging-', dir=scratch_root) as staging:
        staging_config = Path(staging) / 'config'
        # SQLite backup avoids copying a live database without its WAL.
        shutil.copytree(config, staging_config, ignore=shutil.ignore_patterns('logs', 'db.sqlite3*'))
        import sqlite3
        (staging_config / 'db').mkdir(exist_ok=True)
        source = sqlite3.connect(f'file:{config}/db/db.sqlite3?mode=ro', uri=True)
        target = sqlite3.connect(staging_config / 'db/db.sqlite3')
        source.backup(target)
        target.close()
        source.close()
        if policy:
            patch_policy(staging_config, policy)
        run('docker', 'network', 'create', '--internal', network)
        try:
            run('docker', 'run', '-d', '--name', candidate, '--network', network,
                '-v', f'{staging_config}:/app/config', '-e', 'PORT=5055', image)
            wait_healthy(candidate)
        finally:
            subprocess.run(['docker', 'rm', '-f', candidate], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(['docker', 'network', 'rm', network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print('Isolated startup passed; backing up Seerr before deployment', flush=True)
    original_compose = compose.read_text()
    # Stop before copying the full DB/config so rollback restores a consistent pair.
    run('docker', 'compose', '-f', str(compose), 'stop', 'seerr')
    try:
        shutil.copytree(config, backup / 'config')
    except BaseException:
        run('docker', 'compose', '-f', str(compose), 'start', 'seerr')
        raise
    try:
        if policy:
            patch_policy(config, policy)
        updated, count = re.subn(r'(?m)^([ \t]+image:)[ \t]*[^ \t\r\n]+[ \t]*$', lambda m: f'{m[1]} {image}', original_compose)
        if count != 1:
            raise RuntimeError('Expected one Seerr image in compose file')
        compose.write_text(updated)
        run('docker', 'compose', '-f', str(compose), 'up', '-d', '--no-deps', 'seerr')
        wait_healthy('seerr')
        print(f'Deployed {image}; backup: {backup}', flush=True)
    except BaseException:
        subprocess.run(['docker', 'compose', '-f', str(compose), 'stop', 'seerr'])
        shutil.move(config, backup / 'failed-config')
        shutil.copytree(backup / 'config', config)
        compose.write_text(original_compose)
        run('docker', 'compose', '-f', str(compose), 'up', '-d', '--no-deps', 'seerr')
        print(f'Rolled back image and database from {backup}', flush=True)
        raise


def patch_policy(config, policy):
    settings_path = config / 'settings.json'
    settings = json.loads(settings_path.read_text())
    settings['movieAudio'] = policy
    settings_path.write_text(json.dumps(settings, indent=2) + '\n')


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path.home() / 'maintenance/seerr')
    parser.add_argument('--compose', type=Path, default=Path.home() / 'docker/jellyseerr/docker-compose.yml')
    parser.add_argument('--image', help='Install an already-built image (initial verified deployment)')
    parser.add_argument('--policy', type=Path, help='Initial non-secret audio policy JSON')
    parser.add_argument('--check', action='store_true', help='Check verification only, without building or deploying')
    args = parser.parse_args()
    args.root.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = (args.root / 'update.lock').open('w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    scratch = scratch_directory()
    if args.image:
        deploy(args.image, args.compose, scratch, args.root / 'backups', json.loads(args.policy.read_text()) if args.policy else None)
        return
    sha = api(f'repos/{REPO}/git/ref/heads/{BRANCH}')['object']['sha']
    statuses = api(f'repos/{REPO}/commits/{sha}/statuses')
    verified = next((s for s in statuses if s['context'] == 'homeserver/verified'), None)
    if not verified or verified['state'] != 'success' or verified['creator']['login'] != 'github-actions[bot]':
        raise RuntimeError('Latest fork commit has not passed homeserver verification')
    # Check the named workflow, repository and run result instead of trusting a status label alone.
    run_id = verified['target_url'].rstrip('/').split('/')[-1]
    workflow = api(f'repos/{REPO}/actions/runs/{run_id}')
    if workflow['path'] != '.github/workflows/homeserver.yml' or workflow['conclusion'] != 'success':
        raise RuntimeError('Verification workflow did not complete successfully')
    print(f'Verified fork commit: {sha}', flush=True)
    if args.check:
        return
    current = json.loads(run('docker', 'inspect', 'seerr', capture=True))[0]
    if current['Config'].get('Labels', {}).get('homeserver.commit') == sha:
        print('Seerr is already current', flush=True)
        return
    source = args.root / 'source'
    if not source.exists():
        run('git', 'clone', '--no-checkout', f'https://github.com/{REPO}.git', str(source))
    run('git', 'fetch', 'origin', BRANCH, cwd=source)
    image = f'seerr-homeserver:{sha}'
    with tempfile.TemporaryDirectory(prefix='seerr-build-', dir=scratch) as work:
        run('git', 'worktree', 'add', '--detach', work, sha, cwd=source)
        try:
            run('docker', 'build', '--build-arg', f'COMMIT_TAG={sha}', '--label', f'homeserver.commit={sha}', '-t', image, '.', cwd=work)
        finally:
            run('git', 'worktree', 'remove', '--force', work, cwd=source)
    deploy(image, args.compose, scratch, args.root / 'backups')


if __name__ == '__main__':
    main()
