import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

// GET /api/auth/me
router.get("/me", requireAuth, (req, res) => {
  res.json((req as any).user);
});

export default router;