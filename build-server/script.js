const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const mime = require("mime-types");
const Redis = require("ioredis");
require("dotenv").config();

const publisher = new Redis(process.env.REDIS_URL);

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const PROJECT_ID = process.env.PROJECT_ID;
if (!PROJECT_ID) {
  console.error("PROJECT_ID environment variable is required");
  process.exit(1);
}

function publishLog(log) {
  console.log(`Publishing to logs:${PROJECT_ID}:`, log);
  publisher.publish(`logs:${PROJECT_ID}`, JSON.stringify({ log }));
}

async function init() {
  console.log("Executing script.js");
  publishLog("Build started");

  const outDir = path.join(__dirname, "output");

  if (!fs.existsSync(outDir)) {
    publishLog("Output directory not found, creating...");
    fs.mkdirSync(outDir, { recursive: true });
  }

  publishLog("Starting npm install...");

  const p = exec(`cd ${outDir} && npm install && npm run build`);

  p.stdout.on("data", function (data) {
    console.log(data.toString());
    publishLog(data.toString().trim());
  });

  p.stderr.on("data", function (data) {
    console.error("Error:", data.toString());
    publishLog(`ERROR: ${data.toString().trim()}`);
  });

  p.on("close", async function (code) {
    publishLog(`Build process finished with code: ${code}`);

    if (code !== 0) {
      publishLog("Build failed!");
      return;
    }

    publishLog("Build completed successfully");
    console.log("Build complete");

    const distFold = path.join(outDir, "dist");
    if (!fs.existsSync(distFold)) {
      publishLog("Dist folder not found, checking for other build outputs...");
      return;
    }

    const distFoldCont = fs.readdirSync(distFold, { recursive: true });
    publishLog(`Found ${distFoldCont.length} files to upload`);

    for (const fileP of distFoldCont) {
      const fullPath = path.join(distFold, fileP);
      if (fs.lstatSync(fullPath).isDirectory()) continue;

      console.log("Uploading", fileP);
      publishLog(`Uploading ${fileP}`);

      const command = new PutObjectCommand({
        Bucket: "vercel-deploy-obj",
        Key: `__output/${PROJECT_ID}/${fileP}`,
        Body: fs.createReadStream(fullPath),
        ContentType: mime.lookup(fileP) || "application/octet-stream",
      });

      await s3Client.send(command);
      publishLog(`Uploaded ${fileP}`);
      console.log("Uploaded", fileP);
    }

    publishLog("Deployment completed successfully!");
    console.log("Done");
  });

  p.on("error", function (error) {
    publishLog(`Process error: ${error.message}`);
    console.error("Process error:", error);
  });
}

publisher
  .ping()
  .then(() => {
    console.log("Redis connected successfully");
    publishLog("Container started, Redis connected");
    init();
  })
  .catch((error) => {
    console.error("Redis connection failed:", error);
    publishLog(`Redis connection failed: ${error.message}`);
  });
