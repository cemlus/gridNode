import sys
import unittest

sys.path.insert(0, ".")
from computeshare_agent.docker_runner import resolve_allocation, is_viable, build_command


MOCK_RESOURCES = {
    "cpu": {"total_cores": 8, "free_cores": 6.0, "usable_cores": 5.0},
    "ram": {"total_gb": 16.0, "available_gb": 10.0, "usable_gb": 8.5},
    "gpu": None,
    "disk": {"free_gb": 100.0},
}

MOCK_JOB = {
    "job_id": "test_001",
    "type": "ml_notebook",
    "github_repo": "https://github.com/user/repo",
    "notebook_path": "train.ipynb",
    "cpu_request": 4,
    "ram_request_gb": 6,
    "gpu_required": False,
    "timeout_seconds": 300,
}


class TestDockerRunner(unittest.TestCase):

    def test_allocation_respects_request(self):
        alloc = resolve_allocation(MOCK_JOB, MOCK_RESOURCES)
        # Should not exceed what was requested
        self.assertLessEqual(alloc["cpu"], MOCK_JOB["cpu_request"])
        self.assertLessEqual(alloc["ram_gb"], MOCK_JOB["ram_request_gb"])

    def test_allocation_capped_by_machine(self):
        hungry_job = {**MOCK_JOB, "cpu_request": 100, "ram_request_gb": 100}
        alloc = resolve_allocation(hungry_job, MOCK_RESOURCES)
        # Should never exceed usable
        self.assertLessEqual(alloc["cpu"], MOCK_RESOURCES["cpu"]["usable_cores"])
        self.assertLessEqual(alloc["ram_gb"], MOCK_RESOURCES["ram"]["usable_gb"])

    def test_no_gpu_allocated_when_none_available(self):
        gpu_job = {**MOCK_JOB, "gpu_required": True, "gpu_vram_mb": 4096}
        alloc = resolve_allocation(gpu_job, MOCK_RESOURCES)
        self.assertIsNone(alloc["gpu"])

    def test_viable_job_passes(self):
        alloc = resolve_allocation(MOCK_JOB, MOCK_RESOURCES)
        viable, reason = is_viable(alloc, MOCK_JOB)
        self.assertTrue(viable)
        self.assertIsNone(reason)

    def test_gpu_required_but_absent_is_not_viable(self):
        gpu_job = {**MOCK_JOB, "gpu_required": True}
        alloc = resolve_allocation(gpu_job, MOCK_RESOURCES)
        viable, reason = is_viable(alloc, gpu_job)
        self.assertFalse(viable)
        self.assertIn("GPU", reason)

    def test_build_command_contains_limits(self):
        alloc = resolve_allocation(MOCK_JOB, MOCK_RESOURCES)
        cmd, container_name = build_command(MOCK_JOB, "/workspaces/test_001", alloc)
        cmd_str = " ".join(cmd)
        self.assertIn("--cpus=", cmd_str)
        self.assertIn("--memory=", cmd_str)
        self.assertIn("--network none", cmd_str)
        self.assertIn("--gpus", cmd_str) if alloc["gpu"] else None

    def test_container_name_contains_job_id(self):
        alloc = resolve_allocation(MOCK_JOB, MOCK_RESOURCES)
        _, container_name = build_command(MOCK_JOB, "/tmp/ws", alloc)
        self.assertIn("test_001", container_name)


if __name__ == "__main__":
    unittest.main()