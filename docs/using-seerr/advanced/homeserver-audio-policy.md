# Homeserver movie audio and provider routing

Seerr's movie audio settings select the protected PT-PT profile for Family/Animation movies with a Portugal rating below 12, plus explicit exceptions. Other movies use the original-language profile. Family/Animation movies whose Portugal rating is missing require review.

## Missing Portugal ratings

Movie exceptions are explicit audience decisions and take priority over metadata. For example, an unrated children's film can be saved as PT-PT without pretending that TMDB supplied a Portugal certification. Request-specific audio choices take priority over saved exceptions.

An optional **Missing Portugal Ratings** setting enables TypeSafe Jev audience assessment. Configure `TYPESAFE_API_KEY` in the Seerr server's environment, using a private runtime secret or an untracked deployment env file, then select automatic assessment in Movie Audio settings. The key is never sent to clients or saved in Seerr settings. The default remains manual review until the provider has been configured and its classifications checked against a representative selection of children's films, teen films and adult animation.

The integration sends only public movie metadata: title, synopsis, genres, keywords and available country certifications. It uses `jev-1.13.0` with a typed choice between children/family below the cutoff, older/general audiences, and uncertain. Available Portugal ratings, explicit request choices, disabled policies and unconfigured Radarr destinations bypass the model. It does not invent a Portugal age rating or override the provider restrictions in Radarr.

Automatic routing requires confidence of at least 0.90 and a probability of at least 0.95 for the selected audience. These are conservative provisional thresholds, not a guarantee of suitability; validate them against the household's movie decisions before enabling. Uncertain, invalid, timed-out or failed responses leave the request awaiting an audio choice. The original-language profile is never used as a silent fallback for an unresolved children's film.

Public evidence and assessments are cached under the Seerr config directory's `movie-audience/` folder for 30 days. Changed metadata, cutoff, mode, rubric or model produces a different cache key. Concurrent previews for the same evidence share a request. The integration is used for preview, request creation, approval, updates and legacy-request retries before any Radarr search.

API reference: [TypeSafe HTTP API](https://docs.typesafe.ai/api), [choice questions](https://docs.typesafe.ai/primitives/choice), and [confidence](https://docs.typesafe.ai/confidence).

Radarr's `PT-PT Kids (Protected)` profile requires the `PT-PT Audio Required` custom format, with a minimum score of 10,000 and upgrades disabled. The custom format requires the `Portuguese PT-PT` suffix added by the Portugas Prowlarr definition when the provider's `audio_pt` flag is true. A filename containing `PT-PT`, a subtitle label, or generic Portuguese does not satisfy it.

The native Radarr automatic tagging rules apply provider routing before a movie is added or its profile is updated:

- The protected PT-PT profile receives `portugas-only`, and loses `original-audio-providers`.
- Other profiles receive `original-audio-providers`, and lose `portugas-only`.
- Portugas accepts both routing tags. Every other Radarr indexer accepts only `original-audio-providers`.

Radarr applies these indexer restrictions to interactive searches, automatic searches, and RSS release decisions. The tags use OR matching, so other tags must not be added to an indexer's routing list. Unrelated movie tags are preserved.

Prowlarr's Radarr application stays on full sync, which preserves the indexer tags configured in Radarr. Its `radarr-audio-policy` application tag limits synchronization to the existing, explicitly routed providers. New Prowlarr providers without that tag are not automatically admitted. Before admitting a new provider, configure its Radarr indexer with only `original-audio-providers`, then apply the Prowlarr admission tag. Sonarr's application settings and existing proxy tags are preserved.

On the homeserver, run `python3 ~/maintenance/seerr/configure-radarr-providers.py` to configure or repair this routing. The script validates the Portugas/Prowlarr mapping before making changes, backs up the modified settings without API keys, and verifies the result. It preserves quality profiles, monitoring, unrelated movie tags, and media files. It does not search or grab releases.

Backups and verification reports are stored in `~/maintenance/seerr/radarr-backups/<timestamp>-providers/`.
