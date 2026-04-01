import { Server } from "socket.io";
import { Server as HttpServer } from "http";

let io: Server;

export const initSocket = (server: HttpServer) => {
  io = new Server(server, {
    cors: {
      origin: "http://localhost:3000",
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    console.log("Connected:", socket.id);

    socket.on("join-job", (jobId) => {
      socket.join(`job-${jobId}`);
    });
  });
};

export const emitLog = (jobId: string, log: string) => {
  io?.to(`job-${jobId}`).emit("log", log);
};