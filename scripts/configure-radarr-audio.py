#!/usr/bin/env python3
"""Create dedicated audio profiles without searching, grabbing or deleting media."""
import copy
import json
import os
from pathlib import Path
import time
import urllib.request
import xml.etree.ElementTree as ET

# Portugas's Prowlarr definition appends this suffix only when audio_pt is true.
# A filename containing PT-PT alone can describe subtitles and is insufficient.
PT_PT_AUDIO_MARKER = r'(?i)(?<![a-z])Portuguese[ \t]+PT-PT[ \t]*$'


def required_pt_pt_format():
    return {
        'name': 'PT-PT Audio Required', 'includeCustomFormatWhenRenaming': True,
        'specifications': [{
            'name': 'Portugas Portugal audio flag', 'implementation': 'ReleaseTitleSpecification',
            'negate': False, 'required': True,
            'fields': [{'name': 'value', 'value': PT_PT_AUDIO_MARKER}],
        }],
    }


def main():
    os.umask(0o077)
    config = ET.parse('/var/lib/radarr/config.xml').getroot()
    base = f'http://127.0.0.1:{config.findtext("Port")}/api/v3/'

    def api(path, data=None, method=None):
        request = urllib.request.Request(base + path, data=None if data is None else json.dumps(data).encode(),
                                        headers={'X-Api-Key': config.findtext('ApiKey'), 'Content-Type': 'application/json'}, method=method)
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

    profiles = api('qualityprofile')
    formats = api('customformat')
    movies = api('movie')
    backup = Path.home() / 'maintenance/seerr/radarr-backups' / time.strftime('%Y%m%d-%H%M%S')
    backup.mkdir(parents=True, mode=0o700)
    (backup / 'before.json').write_text(json.dumps({
        'profiles': profiles, 'formats': formats,
        'movies': [{'id': m['id'], 'qualityProfileId': m['qualityProfileId'], 'monitored': m['monitored'], 'tags': m['tags']} for m in movies],
    }, indent=2))
    name = 'PT-PT Audio Required'
    custom = next((f for f in formats if f['name'] == name), None)
    desired = required_pt_pt_format()
    if custom:
        custom = api(f'customformat/{custom["id"]}', {**desired, 'id': custom['id']}, 'PUT')
    else:
        custom = api('customformat', desired, 'POST')
    # Refresh so the base includes the newly added format.
    profiles = api('qualityprofile')
    template = next(p for p in profiles if p['id'] == 1)
    created = {}
    for kind, profile_name in [('kids', 'PT-PT Kids (Protected)'), ('original', 'Original Audio (1080p+)')]:
        existing = next((p for p in profiles if p['name'] == profile_name), None)
        profile = copy.deepcopy(template)
        profile.pop('id', None)
        profile.update(name=profile_name, language={'id': 18 if kind == 'kids' else -2, 'name': 'Portuguese' if kind == 'kids' else 'Original'})
        for item in profile['formatItems']:
            item['score'] = 10000 if kind == 'kids' and item['format'] == custom['id'] else 0
        if kind == 'kids':
            profile.update(upgradeAllowed=False, minFormatScore=10000, cutoffFormatScore=10000)
        else:
            profile.update(minFormatScore=0, cutoffFormatScore=0)
        if existing:
            profile['id'] = existing['id']
            saved = api(f'qualityprofile/{existing["id"]}', profile, 'PUT')
        else:
            saved = api('qualityprofile', profile, 'POST')
        created[kind] = saved['id']
    policy = {
        'enabled': True, 'kidsMode': 'family', 'ageCutoff': 12,
        'profiles': [{'radarrServiceId': 0, 'kidsProfileId': created['kids'], 'originalProfileId': created['original']}],
        'exceptions': [{'tmdbId': 803796, 'preference': 'pt-PT', 'note': 'KPop Demon Hunters: Netflix Portugal 10+; PT rating absent in TMDB'}],
    }
    output = Path.home() / 'maintenance/seerr/audio-policy.json'
    output.write_text(json.dumps(policy, indent=2) + '\n')
    print(json.dumps({'profiles': created, 'formatId': custom['id'], 'backup': str(backup), 'policy': str(output)}))


if __name__ == '__main__':
    main()
