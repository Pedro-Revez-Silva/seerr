import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('provider_config', Path(__file__).with_name('configure-radarr-providers.py'))
provider_config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider_config)


class ProviderRouting(unittest.TestCase):
    def test_only_portugas_can_match_children_even_if_other_sources_were_untagged(self):
        kids_tag, original_tag, portugas = 2, 3, 1
        for indexer in [1, 2, 3, 5, 7, 999]:
            tags = set(provider_config.indexer_tags(indexer, portugas, kids_tag, original_tag))
            self.assertTrue(tags, 'Untagged indexers are available to every movie')
            self.assertEqual(kids_tag in tags, indexer == portugas)
            self.assertIn(original_tag, tags, 'Original movies retain all providers')

    def test_profile_rules_remove_stale_routing_on_profile_changes(self):
        kids = provider_config.auto_rule('Kids', 2, 7, False)
        original = provider_config.auto_rule('Original', 3, 7, True)
        self.assertTrue(kids['removeTagsAutomatically'])
        self.assertTrue(original['removeTagsAutomatically'])
        self.assertFalse(kids['specifications'][0]['negate'])
        self.assertTrue(original['specifications'][0]['negate'])
        self.assertEqual(kids['specifications'][0]['fields'][0]['value'], 7)
        self.assertEqual(original['specifications'][0]['fields'][0]['value'], 7)

    def test_provider_identity_requires_a_matching_prowlarr_source(self):
        sources = [{'id': 1, 'name': 'Portugas (API)'}, {'id': 6, 'name': 'NZBgeek'}]
        indexers = [
            {'id': 1, 'name': 'Portugas (API) (Prowlarr)', 'fields': [{'name': 'baseUrl', 'value': 'http://localhost:9696/1/'}]},
            {'id': 5, 'name': 'NZBgeek (Prowlarr)', 'fields': [{'name': 'baseUrl', 'value': 'http://localhost:9696/6/'}]},
        ]
        self.assertEqual(provider_config.routing_sources(indexers, sources, 9696), (1, {1: 1, 5: 6}))
        indexers[0]['fields'][0]['value'] = 'http://localhost:9696/6/'
        with self.assertRaisesRegex(RuntimeError, 'Unrecognized indexer'):
            provider_config.routing_sources(indexers, sources, 9696)

    def test_missing_portugas_aborts_before_configuration(self):
        with self.assertRaisesRegex(RuntimeError, 'exactly one Portugas'):
            provider_config.routing_sources([], [], 9696)


if __name__ == '__main__':
    unittest.main()
