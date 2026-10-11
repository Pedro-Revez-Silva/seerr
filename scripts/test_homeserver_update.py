import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('updater', Path(__file__).with_name('homeserver-update.py'))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class DeploymentRollback(unittest.TestCase):
    def test_failed_live_verification_restores_database_and_image(self):
        root = Path.home() / '.cache/agent-tmp'
        root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root) as scratch:
            directory = Path(scratch)
            compose = directory / 'docker-compose.yml'
            original = 'services:\n  seerr:\n    image: previous:verified\n    container_name: seerr\n'
            compose.write_text(original)
            config = directory / 'config'
            (config / 'db').mkdir(parents=True)
            (config / 'settings.json').write_text('{"old":true}')
            with sqlite3.connect(config / 'db/db.sqlite3') as db:
                db.execute('CREATE TABLE marker (value TEXT)')
                db.execute("INSERT INTO marker VALUES ('before')")

            def health(container):
                if container == 'seerr':
                    with sqlite3.connect(config / 'db/db.sqlite3') as db:
                        db.execute("UPDATE marker SET value='after-migration'")
                    raise RuntimeError('startup failed')

            with patch.object(updater, 'run'), patch.object(updater, 'wait_healthy', side_effect=health), patch.object(updater.subprocess, 'run'):
                with self.assertRaisesRegex(RuntimeError, 'startup failed'):
                    updater.deploy('new:verified', compose, directory, directory / 'backups')
            self.assertEqual(compose.read_text(), original)
            self.assertEqual((config / 'settings.json').read_text(), '{"old":true}')
            with sqlite3.connect(config / 'db/db.sqlite3') as db:
                self.assertEqual(db.execute('SELECT value FROM marker').fetchone()[0], 'before')

    def test_bad_staging_build_never_stops_production(self):
        root = Path.home() / '.cache/agent-tmp'
        root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root) as scratch:
            directory = Path(scratch)
            compose = directory / 'docker-compose.yml'
            compose.write_text('services:\n  seerr:\n    image: previous:verified\n')
            config = directory / 'config'
            (config / 'db').mkdir(parents=True)
            with sqlite3.connect(config / 'db/db.sqlite3') as db:
                db.execute('CREATE TABLE marker (value TEXT)')
            with patch.object(updater, 'run') as run, patch.object(updater, 'wait_healthy', side_effect=RuntimeError('bad staging')), patch.object(updater.subprocess, 'run'):
                with self.assertRaisesRegex(RuntimeError, 'bad staging'):
                    updater.deploy('bad:build', compose, directory, directory / 'backups')
            self.assertFalse(any('stop' in call.args for call in run.call_args_list))
            self.assertIn('previous:verified', compose.read_text())


if __name__ == '__main__':
    unittest.main()
