#!/usr/bin/env python3
"""Restrict PT-PT movies to Portugas without searching or touching media files."""
import collections
import json
import os
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

KIDS_PROFILE = 'PT-PT Kids (Protected)'
KIDS_TAG = 'portugas-only'
ORIGINAL_TAG = 'original-audio-providers'
SYNC_TAG = 'radarr-audio-policy'


class Api:
    def __init__(self, app, version):
        config = ET.parse(f'/var/lib/{app}/config.xml').getroot()
        self.port = int(config.findtext('Port'))
        self.base = f'http://127.0.0.1:{self.port}/api/{version}/'
        self.key = config.findtext('ApiKey')

    def __call__(self, path, data=None, method=None):
        request = urllib.request.Request(
            self.base + path, data=None if data is None else json.dumps(data).encode(),
            headers={'X-Api-Key': self.key, 'Content-Type': 'application/json'}, method=method,
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read()
            return json.loads(body) if body else None


def routing_sources(indexers, prowlarr_indexers, prowlarr_port):
    """Validate provenance before changing anything; names alone are insufficient."""
    sources = {i['id']: i for i in prowlarr_indexers}
    mapping = {}
    for indexer in indexers:
        base = next((f.get('value') or '' for f in indexer['fields'] if f['name'] == 'baseUrl'), '')
        url = urllib.parse.urlsplit(base)
        match = re.fullmatch(r'/([0-9]+)/?', url.path)
        source = sources.get(int(match[1])) if match else None
        if url.port != prowlarr_port or source is None or indexer['name'] != source['name'] + ' (Prowlarr)':
            raise RuntimeError(f'Unrecognized indexer {indexer["id"]}; configure its routing explicitly first')
        mapping[indexer['id']] = source['id']
    portugas = [i['id'] for i in indexers if sources[mapping[i['id']]]['name'] == 'Portugas (API)']
    if len(portugas) != 1:
        raise RuntimeError('Expected exactly one Portugas API indexer')
    return portugas[0], mapping


def auto_rule(name, tag_id, profile_id, negate):
    return {
        'name': name, 'removeTagsAutomatically': True, 'tags': [tag_id],
        'specifications': [{
            'name': 'PT-PT kids profile', 'implementation': 'QualityProfileSpecification',
            'negate': negate, 'required': True,
            'fields': [{'name': 'value', 'value': profile_id}],
        }],
    }


def indexer_tags(indexer_id, portugas_id, kids_tag, original_tag):
    # Radarr uses OR for indexer tags. No unrelated tag may grant access to kids.
    return [kids_tag, original_tag] if indexer_id == portugas_id else [original_tag]


def ensure_tag(api, label):
    existing = next((t for t in api('tag') if t['label'] == label), None)
    return (existing or api('tag', {'label': label}, 'POST'))['id']


def ensure_rule(api, rule):
    existing = next((r for r in api('autotagging') if r['name'] == rule['name']), None)
    if existing:
        rule['id'] = existing['id']
        if all(existing.get(k) == v for k, v in rule.items()):
            return
        api(f'autotagging/{existing["id"]}', rule, 'PUT')
    else:
        api('autotagging', rule, 'POST')


def snapshot_movies(movies):
    return [{k: m.get(k) for k in ['id', 'qualityProfileId', 'monitored', 'tags', 'hasFile', 'movieFileId']} for m in movies]


def verify(radarr, prowlarr, profile_id, portugas_id, mapping, app_id, kids_tag, original_tag, sync_tag):
    movies = radarr('movie')
    for movie in movies:
        wanted = kids_tag if movie['qualityProfileId'] == profile_id else original_tag
        unwanted = original_tag if wanted == kids_tag else kids_tag
        if wanted not in movie['tags'] or unwanted in movie['tags']:
            raise RuntimeError(f'Movie {movie["id"]} has incorrect provider routing')
    indexers = radarr('indexer')
    if {i['id'] for i in indexers} != set(mapping):
        raise RuntimeError('Indexer set changed during provider configuration')
    for indexer in indexers:
        if set(indexer['tags']) != set(indexer_tags(indexer['id'], portugas_id, kids_tag, original_tag)):
            raise RuntimeError(f'Indexer {indexer["id"]} has incorrect provider routing')
    app = prowlarr(f'applications/{app_id}')
    if app['tags'] != [sync_tag]:
        raise RuntimeError('Prowlarr Radarr admission restriction is missing')
    sources = prowlarr('indexer')
    if {i['id'] for i in sources if sync_tag in i['tags']} != set(mapping.values()):
        raise RuntimeError('Prowlarr admission tags do not match the configured indexers')
    return {
        'kidsMovies': sum(m['qualityProfileId'] == profile_id for m in movies),
        'otherMovies': sum(m['qualityProfileId'] != profile_id for m in movies),
        'files': sum(m['hasFile'] for m in movies),
        'indexers': [{k: i[k] for k in ['id', 'name', 'tags', 'enableRss', 'enableAutomaticSearch', 'enableInteractiveSearch']} for i in indexers],
        'routingTags': {'kids': kids_tag, 'original': original_tag, 'prowlarrAdmission': sync_tag},
    }


def main():
    os.umask(0o077)
    radarr, prowlarr = Api('radarr', 'v3'), Api('prowlarr', 'v1')
    profiles = [p for p in radarr('qualityprofile') if p['name'] == KIDS_PROFILE]
    if len(profiles) != 1:
        raise RuntimeError('Expected exactly one protected PT-PT profile')
    profile_id = profiles[0]['id']
    indexers, sources = radarr('indexer'), prowlarr('indexer')
    portugas_id, mapping = routing_sources(indexers, sources, prowlarr.port)
    apps = [a for a in prowlarr('applications') if a['implementation'] == 'Radarr']
    if len(apps) != 1:
        raise RuntimeError('Expected exactly one Prowlarr Radarr application')
    app = apps[0]
    movies = radarr('movie')
    release_profiles = radarr('releaseprofile')
    backup = Path.home() / 'maintenance/seerr/radarr-backups' / time.strftime('%Y%m%d-%H%M%S-providers')
    backup.mkdir(parents=True, mode=0o700)
    # Provider resources contain API keys; save only the settings we change.
    (backup / 'before.json').write_text(json.dumps({
        'radarrTags': radarr('tag'), 'autoTagging': radarr('autotagging'),
        'indexers': [{k: i[k] for k in ['id', 'name', 'tags']} for i in indexers],
        'releaseProfiles': release_profiles, 'movies': snapshot_movies(movies),
        'prowlarrTags': prowlarr('tag'),
        'prowlarrIndexers': [{k: i[k] for k in ['id', 'name', 'tags']} for i in sources],
        'prowlarrApplication': {k: app[k] for k in ['id', 'name', 'tags', 'syncLevel']},
    }, indent=2) + '\n')
    kids_tag = ensure_tag(radarr, KIDS_TAG)
    original_tag = ensure_tag(radarr, ORIGINAL_TAG)
    sync_tag = ensure_tag(prowlarr, SYNC_TAG)
    ensure_rule(radarr, auto_rule('Movie audio: Portugas only', kids_tag, profile_id, False))
    ensure_rule(radarr, auto_rule('Movie audio: Original providers', original_tag, profile_id, True))
    # Re-evaluate native auto-tagging without changing profiles or monitoring.
    groups = collections.defaultdict(list)
    for movie in movies:
        groups[movie['qualityProfileId']].append(movie['id'])
    for existing_profile, ids in groups.items():
        radarr('movie/editor', {'movieIds': ids, 'qualityProfileId': existing_profile}, 'PUT')
    for indexer in indexers:
        tags = indexer_tags(indexer['id'], portugas_id, kids_tag, original_tag)
        if set(indexer['tags']) != set(tags):
            indexer['tags'] = tags
            radarr(f'indexer/{indexer["id"]}', indexer, 'PUT')
    for restriction in release_profiles:
        if restriction['indexerId'] == portugas_id and restriction['required'] == ['PT-PT'] and not restriction['tags']:
            restriction['tags'] = [kids_tag]
            radarr(f'releaseprofile/{restriction["id"]}', restriction, 'PUT')
    # Unknown future Prowlarr providers are not automatically admitted to Radarr.
    # Preserve proxy tags (e.g. FlareSolverr) and other applications' settings.
    for source in sources:
        tags = set(source['tags']) - {sync_tag}
        if source['id'] in mapping.values():
            tags.add(sync_tag)
        if tags != set(source['tags']):
            source['tags'] = sorted(tags)
            prowlarr(f'indexer/{source["id"]}', source, 'PUT')
    if app['tags'] != [sync_tag]:
        app['tags'] = [sync_tag]
        prowlarr(f'applications/{app["id"]}', app, 'PUT')
    after = radarr('movie')
    before_by_id = {m['id']: m for m in movies}
    if set(before_by_id) != {m['id'] for m in after}:
        raise RuntimeError('Movie set changed during provider configuration')
    for movie in after:
        before = before_by_id[movie['id']]
        for key in ['qualityProfileId', 'monitored', 'hasFile', 'movieFileId']:
            if movie.get(key) != before.get(key):
                raise RuntimeError(f'Movie {movie["id"]}: {key} changed unexpectedly')
        if not (set(before['tags']) - {kids_tag, original_tag}).issubset(movie['tags']):
            raise RuntimeError(f'Movie {movie["id"]}: unrelated tags were removed')
    result = verify(radarr, prowlarr, profile_id, portugas_id, mapping, app['id'], kids_tag, original_tag, sync_tag)
    result['backup'] = str(backup)
    (backup / 'verification.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
