import importlib.util
from pathlib import Path
import re
import unittest

spec = importlib.util.spec_from_file_location('audio_config', Path(__file__).with_name('configure-radarr-audio.py'))
audio_config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audio_config)


class PortugasAudioEvidence(unittest.TestCase):
    def test_real_provider_audio_flag_suffix_is_accepted(self):
        titles = [
            'KPop.Demon.Hunters.2025.1080p.NF.WEB-DL.AAC5.1.H.264-OldT.mkv Portuguese PT-PT',
            'KPop.Demon.Hunters.2025.1080p.NF.WEB-DL.DD+5.1.H.264-VOiD.mkv Portuguese PT-PT',
            'Toy.Story.5.2026.2160p.WEB-DL.mkv Portuguese PT-PT',
        ]
        for title in titles:
            with self.subTest(title=title):
                self.assertIsNotNone(re.search(audio_config.PT_PT_AUDIO_MARKER, title))

    def test_provider_and_language_names_without_audio_flag_are_rejected(self):
        titles = [
            'KPop.Demon.Hunters.2025.1080p.NF.WEB-DL.DD+5.1.Atmos.H.264-playWEB.mkv',
            'KPop.Demon.Hunters.2025.1080p.WEB-DL-Portugas.mkv',
            'KPop.Demon.Hunters.2025.1080p.WEB-DL.Portuguese.mkv',
            'KPop.Demon.Hunters.2025.1080p.WEB-DL.PT-BR.mkv',
            'KPop.Demon.Hunters.2025.1080p.WEB-DL.PT-PT.mkv',
        ]
        for title in titles:
            with self.subTest(title=title):
                self.assertIsNone(re.search(audio_config.PT_PT_AUDIO_MARKER, title))

    def test_subtitle_labels_do_not_satisfy_audio_requirement(self):
        titles = [
            'KPop.Demon.Hunters.2025.1080p.WEB-DL.ENGLISH.PT-PT.SUBS.mkv',
            'KPop.Demon.Hunters.2025.1080p.WEB-DL.English.Portuguese.Portugal.Subtitles.mkv',
            'KPop.Demon.Hunters.2025.1080p.WEB-DL.mkv Portuguese PT-PT subtitles',
        ]
        for title in titles:
            with self.subTest(title=title):
                self.assertIsNone(re.search(audio_config.PT_PT_AUDIO_MARKER, title))


if __name__ == '__main__':
    unittest.main()
