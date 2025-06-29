require("dotenv").config();
const express = require("express");
const { createServer } = require("http");
const cors = require("cors");
const { generateSlug } = require("random-word-slugs");
const { ECSClient, RunTaskCommand } = require("@aws-sdk/client-ecs");
const { Server } = require("socket.io");
const Redis = require("ioredis");

const app = express();
const server = createServer(app);
const PORT = 9000;

app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN,
    methods: ["GET", "POST"],
    credentials: true,
  }),
);
app.use(express.json());

const subscriber = new Redis(process.env.REDIS_URL);
const io = new Server(server, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("subscribe", (channel) => {
    socket.join(channel);
    console.log(`Socket ${socket.id} joined channel: ${channel}`);
    socket.emit("subscribed", `Subscribed to ${channel} logs`);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

async function initRedisSubscribe() {
  console.log("Subscribing to Redis logs:*");
  await subscriber.psubscribe("logs:*");

  subscriber.on("pmessage", (pattern, channel, message) => {
    try {
      const parsed = JSON.parse(message);
      io.to(channel).emit("log", parsed);
    } catch {
      io.to(channel).emit("log", message);
    }
  });
}
initRedisSubscribe();

const ecsClient = new ECSClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

app.post("/test-logs/:projectId", (req, res) => {
  const redis = new Redis(process.env.REDIS_URL);
  const msg = `Test log message at ${new Date().toISOString()}`;
  redis.publish(`logs:${req.params.projectId}`, JSON.stringify(msg));
  res.json({ success: true, message: "Test log sent" });
});

app.post("/project", async (req, res) => {
  const { gitUrl } = req.body;
  if (!gitUrl)
    return res.status(400).json({ error: "Missing gitUrl in request body" });

  const projSlug = generateSlug();

  const command = new RunTaskCommand({
    cluster: process.env.ECS_CLUSTER_ARN,
    taskDefinition: process.env.ECS_TASK_ARN,
    launchType: "FARGATE",
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        assignPublicIp: "ENABLED",
        subnets: [
          process.env.SUBNET_1,
          process.env.SUBNET_2,
          process.env.SUBNET_3,
        ],
        securityGroups: [process.env.SECURITY_GROUP],
      },
    },
    overrides: {
      containerOverrides: [
        {
          name: "vercel-clone",
          environment: [
            { name: "GIT_URL", value: gitUrl },
            { name: "PROJECT_ID", value: projSlug },
          ],
        },
      ],
    },
  });

  try {
    await ecsClient.send(command);
    return res.json({
      status: "queued",
      data: {
        projSlug,
        url: `http://${projSlug}.localhost:8000`,
      },
    });
  } catch (err) {
    console.error("ECS RunTask failed:", err);
    return res.status(500).json({
      error: "ECS RunTask failed",
      details: err.message,
    });
  }
});

server.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
});
