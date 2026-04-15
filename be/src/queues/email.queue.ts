import { Queue } from "bullmq";
import { connection } from "./connection";

export const emailQueue = new Queue("email-notifications", {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});
