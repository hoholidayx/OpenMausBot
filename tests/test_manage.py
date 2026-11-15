import contextlib
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "manage.py"


class RuntimeMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="omb-manager-test-")
        self.addCleanup(self.temporary.cleanup)
        self.data = Path(self.temporary.name).resolve() / "data"
        self.data.mkdir()
        spec = importlib.util.spec_from_file_location("omb_manage_test", SCRIPT)
        self.manager = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {"OPENMAUSBOT_DATA_DIR": str(self.data)}):
            spec.loader.exec_module(self.manager)

    def legacy(self):
        folder = self.data / "service"
        folder.mkdir()
        (folder / "process.lock").touch()
        (folder / "web.log").write_text("old log\n")
        return folder

    def record(self, log):
        argv = ["/fixture/node", "--import", self.manager.IGNORE_HANGUP, str(self.manager.ENTRY)]
        identity = {"started": "fixture start", "command": " ".join(argv)}
        return {"pid": 12345, "identity": identity, "argv": argv, "port": 8799,
                "webhook_port": 8800, "lan": True, "log": str(log)}

    def test_live_record_and_open_log_move_together(self):
        legacy = self.legacy()
        record = self.record(legacy / "web.log")
        (legacy / "process.json").write_text(json.dumps(record))
        with (legacy / "web.log").open("a") as old_log:
            with patch.object(self.manager, "identity", return_value=record["identity"]), \
                 patch.object(self.manager, "healthy", return_value=True), \
                 patch("sys.argv", [str(SCRIPT), "status"]), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(self.manager.main(), 0)
            old_log.write("still logging\n")
        self.assertFalse(legacy.exists())
        self.assertEqual(self.manager.LOG.read_text(), "old log\nstill logging\n")
        moved = json.loads(self.manager.STATE.read_text())
        self.assertEqual(moved["pid"], record["pid"])
        self.assertEqual(moved["log"], str(self.manager.LOG))
        self.assertNotEqual(self.manager.RUN.parent, self.data)

    def test_restored_legacy_data_never_replaces_external_record(self):
        self.manager.prepare_runtime()
        record = self.record(self.manager.LOG)
        self.manager.write_record(record)
        legacy = self.legacy()
        (legacy / "process.json").write_text('{"restored": true}')
        self.manager.prepare_runtime()
        self.assertEqual(json.loads(self.manager.STATE.read_text()), record)
        self.assertEqual(json.loads((legacy / "process.json").read_text()), {"restored": True})

    def test_refuses_unrecognized_files_and_reused_pid(self):
        legacy = self.legacy()
        (legacy / "unrelated.txt").write_text("keep")
        with self.assertRaisesRegex(RuntimeError, "Unexpected files"):
            self.manager.prepare_runtime()
        self.assertEqual((legacy / "unrelated.txt").read_text(), "keep")
        (legacy / "unrelated.txt").unlink()
        record = self.record(legacy / "web.log")
        (legacy / "process.json").write_text(json.dumps(record))
        with patch.object(self.manager, "identity", return_value={"started": "other", "command": "other"}):
            with self.assertRaisesRegex(RuntimeError, "does not belong"):
                self.manager.prepare_runtime()
        self.assertFalse(self.manager.RUN.exists())
        self.assertTrue(legacy.exists())

    def test_concurrent_migrations_share_the_original_lock(self):
        self.legacy()
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda _: self.manager.prepare_runtime(), range(32)))
        self.assertEqual(self.manager.LOG.read_text(), "old log\n")
        self.assertTrue((self.manager.RUN / "process.lock").is_file())
        self.assertFalse(self.manager.LEGACY_RUN.exists())


if __name__ == "__main__":
    unittest.main()
