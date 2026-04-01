import { Router } from "express";
import authRoutes from "./auth.routes";
import jobRoutes from "./jobs.routes";
import machineRoutes from "./machines.routes";

const router = Router();

router.use("/auth", authRoutes);
router.use("/jobs", jobRoutes);
router.use("/machines", machineRoutes);

export default router;