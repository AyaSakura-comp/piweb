"""Verify the deployment recovers from the worker's clean SIGTERM exit.
Run: PYTHONDONTWRITEBYTECODE=1 python3 test/test_worker_restart_policy.py
"""
from pathlib import Path
import configparser
import unittest

ROOT = Path(__file__).resolve().parents[1]


class WorkerRestartPolicy(unittest.TestCase):
    def test_clean_sigterm_shutdown_is_restarted(self):
        unit = configparser.ConfigParser(interpolation=None)
        unit.read(ROOT / "deploy/piweb-worker.service")
        # The CLI's SIGTERM handler calls process.exit(0), including when
        # earlyoom sent the signal. on-failure leaves all web messages queued.
        self.assertEqual(unit["Service"]["Restart"], "always")
        self.assertGreaterEqual(int(unit["Service"]["RestartSec"]), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
