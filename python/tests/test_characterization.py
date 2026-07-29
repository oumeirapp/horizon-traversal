from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import app
import pipeline


class FilterCharacterizationTests(unittest.TestCase):
    def test_filter_supports_single_lists_and_reversed_ranges(self):
        self.assertEqual(app.App._parse_filter("P5"), [("P", 5, 5)])
        self.assertEqual(
            app.App._parse_filter("P1, P3; P10"),
            [("P", 1, 1), ("P", 3, 3), ("P", 10, 10)],
        )
        self.assertEqual(app.App._parse_filter("P5-P1"), [("P", 1, 5)])

    def test_folder_matching_accepts_suffixes(self):
        rules = app.App._parse_filter("P2-P4")
        self.assertTrue(app.App._folder_matches(None, "P3 Campaign", rules))
        self.assertFalse(app.App._folder_matches(None, "Q3 Campaign", rules))


class CollectionCharacterizationTests(unittest.TestCase):
    def test_latest_version_is_selected_and_output_is_flat(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "Deliverables"
            output = root / "output"
            (source / "version 1" / "nested").mkdir(parents=True)
            (source / "version 2" / "nested").mkdir(parents=True)
            output.mkdir()
            (source / "version 1" / "nested" / "old.jpg").write_bytes(b"old")
            (source / "version 2" / "nested" / "new.jpg").write_bytes(b"new")

            copied = pipeline.collect_recursive(source, output, pipeline.EXTENSIONS)

            self.assertEqual(copied, 1)
            self.assertEqual([path.name for path in output.iterdir()], ["new.jpg"])

    def test_copy_collisions_receive_incrementing_suffixes(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source"
            output = root / "output"
            source.mkdir()
            output.mkdir()
            asset = source / "asset.jpg"
            asset.write_bytes(b"asset")

            first = pipeline.safe_copy(asset, output)
            second = pipeline.safe_copy(asset, output)

            self.assertEqual(first.name, "asset.jpg")
            self.assertEqual(second.name, "asset_1.jpg")


class MediaCharacterizationTests(unittest.TestCase):
    def test_current_video_dimension_rules_are_recorded(self):
        self.assertIsNone(pipeline.compute_target_dimensions(1280, 720))
        self.assertEqual(pipeline.compute_target_dimensions(1920, 1080), (1280, 720))
        self.assertEqual(pipeline.compute_target_dimensions(1080, 1920), (720, 1280))


class ReportCharacterizationTests(unittest.TestCase):
    def test_current_reports_accumulate_previous_ticket_sources(self):
        with TemporaryDirectory() as temp:
            root = Path(temp) / "input"
            output = Path(temp) / "output"
            first = root / "P1" / "Deliverables"
            second = root / "P2" / "Deliverables"
            first.mkdir(parents=True)
            second.mkdir(parents=True)
            (first / "one.jpg").write_bytes(b"one")
            (second / "two.jpg").write_bytes(b"two")

            with (
                patch.object(pipeline, "convert_pdfs"),
                patch.object(pipeline, "resize_images"),
                patch.object(pipeline, "resize_videos"),
            ):
                pipeline.process_all(str(root), str(output))

            second_report = (output / "P2" / "report.txt").read_text()
            self.assertIn("one.jpg", second_report)
            self.assertIn("two.jpg", second_report)


if __name__ == "__main__":
    unittest.main()
