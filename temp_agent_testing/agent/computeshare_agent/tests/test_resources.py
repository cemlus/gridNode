import sys
import unittest

sys.path.insert(0, ".")
from computeshare_agent.resources import snapshot, print_summary


class TestResources(unittest.TestCase):

    def test_snapshot_has_required_keys(self):
        res = snapshot()
        self.assertIn("cpu", res)
        self.assertIn("ram", res)
        self.assertIn("disk", res)
        # gpu can be None — that's fine

    def test_cpu_values_are_positive(self):
        res = snapshot()
        self.assertGreater(res["cpu"]["total_cores"], 0)
        self.assertGreaterEqual(res["cpu"]["usable_cores"], 0)

    def test_ram_values_are_positive(self):
        res = snapshot()
        self.assertGreater(res["ram"]["total_gb"], 0)
        self.assertGreaterEqual(res["ram"]["usable_gb"], 0)

    def test_print_summary_does_not_crash(self):
        res = snapshot()
        try:
            print_summary(res)
        except Exception as e:
            self.fail(f"print_summary raised: {e}")


if __name__ == "__main__":
    unittest.main()