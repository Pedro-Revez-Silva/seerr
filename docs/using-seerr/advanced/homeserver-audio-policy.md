# Homeserver movie audio and provider routing

Seerr's movie audio settings select the protected PT-PT profile for Family/Animation movies with a Portugal rating below 12, plus explicit exceptions. Other movies use the original-language profile. Family/Animation movies whose Portugal rating is missing require review.

Radarr's `PT-PT Kids (Protected)` profile requires the `PT-PT Audio Required` custom format, with a minimum score of 10,000 and upgrades disabled. The custom format requires the `Portuguese PT-PT` suffix added by the Portugas Prowlarr definition when the provider's `audio_pt` flag is true. A filename containing `PT-PT`, a subtitle label, or generic Portuguese does not satisfy it.

The native Radarr automatic tagging rules apply provider routing before a movie is added or its profile is updated:

- The protected PT-PT profile receives `portugas-only`, and loses `original-audio-providers`.
- Other profiles receive `original-audio-providers`, and lose `portugas-only`.
- Portugas accepts both routing tags. Every other Radarr indexer accepts only `original-audio-providers`.

Radarr applies these indexer restrictions to interactive searches, automatic searches, and RSS release decisions. The tags use OR matching, so other tags must not be added to an indexer's routing list. Unrelated movie tags are preserved.

Prowlarr's Radarr application stays on full sync, which preserves the indexer tags configured in Radarr. Its `radarr-audio-policy` application tag limits synchronization to the existing, explicitly routed providers. New Prowlarr providers without that tag are not automatically admitted. Before admitting a new provider, configure its Radarr indexer with only `original-audio-providers`, then apply the Prowlarr admission tag. Sonarr's application settings and existing proxy tags are preserved.

On the homeserver, run `python3 ~/maintenance/seerr/configure-radarr-providers.py` to configure or repair this routing. The script validates the Portugas/Prowlarr mapping before making changes, backs up the modified settings without API keys, and verifies the result. It preserves quality profiles, monitoring, unrelated movie tags, and media files. It does not search or grab releases.

Backups and verification reports are stored in `~/maintenance/seerr/radarr-backups/<timestamp>-providers/`.
