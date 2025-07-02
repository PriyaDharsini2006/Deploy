require("dotenv").config();
const express = require("express");
const { createServer } = require("http");
const cors = require("cors");
const { generateSlug } = require("random-word-slugs");
const { ECSClient, RunTaskCommand } = require("@aws-sdk/client-ecs");
const { Server } = require("socket.io");
const { z } = require("zod");
const { PrismaClient } = require("@prisma/client");
const { createClient } = require("@clickhouse/client");
const { Kafka } = require("kafkajs");
const { v4: uuidv4 } = require("uuid");

// Setup
const app = express();
const server = createServer(app);
const PORT = 9000;

const prisma = new PrismaClient();
app.use(cors());
app.use(express.json());

const io = new Server(server, { cors: { origin: "*" } });

const kafka = new Kafka({
  clientId: "api-server",
  brokers: [process.env.KAFKA_BROKER],
  ssl: { rejectUnauthorized: false },
  sasl: {
    username: process.env.KAFKA_USERNAME,
    password: process.env.KAFKA_PASSWORD,
    mechanism: "PLAIN",
  },
});

const client = createClient({
  url: process.env.CLICKHOUSE_URL,
  database: process.env.CLICKHOUSE_DB,
  username: process.env.CLICKHOUSE_USER,
  password: process.env.CLICKHOUSE_PASS,
});

const consumer = kafka.consumer({ groupId: "api-server-logs-consumer" });

// Socket.IO
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("subscribe", (channel) => {
    socket.join(channel);
    console.log(`Socket ${socket.id} joined channel: ${channel}`);
    socket.emit("message", JSON.stringify({ log: `Subscribed to ${channel}` }));
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

// ECS Client
const ecsClient = new ECSClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Create Project
app.post("/project", async (req, res) => {
  const schema = z.object({
    name: z.string(),
    gitURL: z.string(),
  });

  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  try {
    const project = await prisma.project.create({
      data: {
        name: result.data.name,
        gitURL: result.data.gitURL,
        subDomain: generateSlug(),
      },
    });

    res.json({ status: "success", data: { project } });
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).json({ error: "Failed to create project" });
  }
});

// Deploy
app.post("/deploy", async (req, res) => {
  const { projectId } = req.body;

  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) return res.status(404).json({ error: "Project not found" });

    const deployment = await prisma.deployment.create({
      data: {
        project: { connect: { id: projectId } },
        status: "QUEUED",
      },
    });

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
              { name: "GIT_URL", value: project.gitURL },
              { name: "PROJECT_ID", value: projectId.toString() },
              { name: "DEPLOYMENT_ID", value: deployment.id.toString() },
              {
                name: "AWS_ACCESS_KEY_ID",
                value: process.env.AWS_ACCESS_KEY_ID,
              },
              {
                name: "AWS_SECRET_ACCESS_KEY",
                value: process.env.AWS_SECRET_ACCESS_KEY,
              },
              { name: "AWS_REGION", value: process.env.AWS_REGION },
            ],
          },
        ],
      },
    });

    const result = await ecsClient.send(command);

    await prisma.deployment.update({
      where: { id: deployment.id },
      data: { status: "IN_PROGRESS" },
    });

    res.json({
      status: "queued",
      data: {
        projectSlug: project.subDomain,
        url: `http://${project.subDomain}.localhost:8000`,
        deploymentId: deployment.id,
        taskArn: result.tasks?.[0]?.taskArn,
      },
    });
  } catch (err) {
    console.error("Deployment failed:", err);
    res.status(500).json({ error: "Deployment failed", details: err.message });
  }
});

// Logs
app.get("/logs/:deploymentId", async (req, res) => {
  try {
    const result = await client.query({
      query: `SELECT event_id, deployment_id, log, timestamp FROM log_events WHERE deployment_id = {deployment_id:String} ORDER BY timestamp DESC LIMIT 100`,
      query_params: {
        deployment_id: req.params.deploymentId,
      },
      format: "JSONEachRow",
    });

    const logs = await result.json();
    res.json({ logs });
  } catch (error) {
    console.error("Error fetching logs:", error);
    res.status(500).json({ error: "Failed to fetch logs" });
  }
});

// Kafka Consumer
async function initKafkaConsumer() {
  const admin = kafka.admin();

  try {
    await admin.connect();
    const topics = await admin.listTopics();

    if (!topics.includes("container-logs")) {
      await admin.createTopics({
        topics: [
          { topic: "container-logs", numPartitions: 1, replicationFactor: 1 },
        ],
      });
    }

    await admin.disconnect();
  } catch (err) {
    console.log("Topic creation error:", err);
  }

  await consumer.connect();
  await consumer.subscribe({ topics: ["container-logs"], fromBeginning: true });

  await consumer.run({
    eachBatch: async ({
      batch,
      heartbeat,
      commitOffsetsIfNecessary,
      resolveOffset,
    }) => {
      for (const message of batch.messages) {
        if (!message.value) continue;

        try {
          const { PROJECT_ID, DEPLOYMENT_ID, log } = JSON.parse(
            message.value.toString(),
          );

          const { query_id } = await client.insert({
            table: "log_events",
            values: [
              {
                event_id: uuidv4(),
                deployment_id: DEPLOYMENT_ID,
                log,
                timestamp: new Date().toISOString(),
              },
            ],
            format: "JSONEachRow",
          });

          io.to(DEPLOYMENT_ID).emit("log", { log, timestamp: Date.now() });

          resolveOffset(message.offset);
          await commitOffsetsIfNecessary();
          await heartbeat();
        } catch (err) {
          console.error("Error processing message:", err);
        }
      }
    },
  });
}

// Start Server
server.listen(PORT, () => {
  console.log(`API Server Running on port ${PORT}`);
  initKafkaConsumer().catch(console.error);
});
