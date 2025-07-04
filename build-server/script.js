const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");
const { Kafka } = require("kafkajs");
const mime = require("mime-types");

// IMPORTANT: Only load .env for local development
if (!process.env.ECS_CONTAINER_METADATA_URI_V4) {
  // Only load .env if not running in ECS container
  require("dotenv").config();
}

const PROJECT_ID = process.env.PROJECT_ID;
const DEPLOYMENT_ID = process.env.DEPLOYMENT_ID;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_REGION = process.env.AWS_REGION;
const GIT_URL = process.env.GIT_URL;

console.log("Environment variables check:");
console.log(`PROJECT_ID: ${PROJECT_ID ? "✓" : "✗"} (${PROJECT_ID})`);
console.log(`DEPLOYMENT_ID: ${DEPLOYMENT_ID ? "✓" : "✗"} (${DEPLOYMENT_ID})`);
console.log(`GIT_URL: ${GIT_URL ? "✓" : "✗"} (${GIT_URL})`);
console.log(`AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID ? "✓" : "✗"}`);
console.log(`AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY ? "✓" : "✗"}`);
console.log(`AWS_REGION: ${AWS_REGION ? "✓" : "✗"} (${AWS_REGION})`);
console.log(
  `Running in ECS: ${process.env.ECS_CONTAINER_METADATA_URI_V4 ? "✓" : "✗"}`,
);

// Exit early if required variables are missing
if (
  !PROJECT_ID ||
  !DEPLOYMENT_ID ||
  PROJECT_ID === "your_project_id" ||
  DEPLOYMENT_ID === "your_deployment_id"
) {
  console.error(
    "PROJECT_ID and DEPLOYMENT_ID environment variables are required and must not be placeholder values",
  );
  process.exit(1);
}

if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_REGION) {
  console.error(
    "AWS credentials (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION) are required",
  );
  process.exit(1);
}

if (!GIT_URL || GIT_URL === "your_git_repo_url") {
  console.error(
    "GIT_URL environment variable is required and must not be a placeholder value",
  );
  process.exit(1);
}

// Initialize Kafka producer
const kafka = new Kafka({
  clientId: `docker-build-server-${DEPLOYMENT_ID}`,
  brokers: [KAFKA_BROKER],
  ssl: {
    rejectUnauthorized: false,
  },
  sasl: {
    username: KAFKA_USERNAME,
    password: KAFKA_PASSWORD,
    mechanism: "PLAIN",
  },
});

// Suppress the partitioner warning
process.env.KAFKAJS_NO_PARTITIONER_WARNING = "1";

const producer = kafka.producer();

// Initialize S3 client with improved configuration
const s3Client = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID.trim(),
    secretAccessKey: AWS_SECRET_ACCESS_KEY.trim(),
  },
  maxAttempts: 5,
  retryMode: "adaptive",
  requestHandler: {
    requestTimeout: 30000,
    httpsAgent: {
      maxSockets: 25,
    },
  },
});

// Function to publish logs to Kafka
async function publishLog(log) {
  try {
    await producer.send({
      topic: "container-logs",
      messages: [
        {
          key: "log",
          value: JSON.stringify({
            PROJECT_ID,
            DEPLOYMENT_ID,
            log,
            timestamp: new Date().toISOString(),
          }),
        },
      ],
    });
    console.log("Log published:", log);
  } catch (error) {
    console.error("Failed to publish log:", error);
    // Don't fail the entire process if logging fails
  }
}

// Function to clone repository
async function cloneRepository(gitUrl, outputDir) {
  return new Promise((resolve, reject) => {
    const cloneCommand = `git clone ${gitUrl} ${outputDir}`;
    console.log("Executing clone command:", cloneCommand);

    exec(cloneCommand, (error, stdout, stderr) => {
      if (error) {
        console.error("Clone error:", error);
        reject(error);
        return;
      }
      if (stderr) {
        console.log("Clone stderr:", stderr);
      }
      console.log("Clone stdout:", stdout);
      resolve();
    });
  });
}

// Function to build project
async function buildProject(projectDir) {
  return new Promise((resolve, reject) => {
    // Check if package.json exists
    const packageJsonPath = path.join(projectDir, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      reject(new Error("package.json not found in project directory"));
      return;
    }

    const buildCommand = `cd ${projectDir} && npm install && npm run build`;
    console.log("Executing build command:", buildCommand);

    const buildProcess = exec(buildCommand, { maxBuffer: 1024 * 1024 * 10 });

    buildProcess.stdout.on("data", async (data) => {
      const logMessage = data.toString().trim();
      console.log(logMessage);
      await publishLog(logMessage);
    });

    buildProcess.stderr.on("data", async (data) => {
      const errorMessage = data.toString().trim();
      console.error("Build Error:", errorMessage);
      await publishLog(`ERROR: ${errorMessage}`);
    });

    buildProcess.on("close", (code) => {
      console.log(`Build process exited with code ${code}`);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Build process exited with code ${code}`));
      }
    });

    buildProcess.on("error", (error) => {
      console.error("Build process error:", error);
      reject(error);
    });
  });
}

// Improved function to upload a single file with retry logic
async function uploadSingleFile(filePath, s3Key, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const fileContent = fs.readFileSync(filePath);
      const stats = fs.statSync(filePath);
      const contentType = mime.lookup(filePath) || "application/octet-stream";

      const normalizedKey = s3Key.replace(/^\/+/, "").replace(/\\/g, "/");

      const command = new PutObjectCommand({
        Bucket: "vercel-deploy-obj",
        Key: normalizedKey,
        Body: fileContent,
        ContentType: contentType,
        ContentLength: stats.size,
        CacheControl: contentType.startsWith("text/html")
          ? "no-cache"
          : "public, max-age=31536000",
      });

      await s3Client.send(command);
      return { success: true, size: stats.size };
    } catch (error) {
      console.error(
        `Attempt ${attempt}/${maxRetries} failed for ${filePath}:`,
        error.message,
      );
      if (attempt === maxRetries) {
        return {
          success: false,
          error: error.message,
          errorCode: error.name,
        };
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.pow(2, attempt) * 1000),
      );
    }
  }
}

// Improved function to upload files to S3 with better error handling and progress tracking
async function uploadToS3(distPath, projectId) {
  const files = getAllFiles(distPath);
  let successCount = 0;
  let failureCount = 0;
  let totalSize = 0;
  const failedFiles = [];

  console.log(`Starting upload of ${files.length} files to S3...`);
  await publishLog(`Starting upload of ${files.length} files to S3...`);

  const batchSize = 10;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const uploadPromises = batch.map(async (file) => {
      const relativePath = path.relative(distPath, file);
      const key = `__output/${projectId}/${relativePath}`;

      console.log(`Uploading ${relativePath} to s3://vercel-deploy-obj/${key}`);
      await publishLog(`Uploading ${relativePath}`);

      const result = await uploadSingleFile(file, key);

      if (result.success) {
        console.log(
          `✓ Uploaded ${relativePath} (${(result.size / 1024).toFixed(2)} KB)`,
        );
        await publishLog(
          `✓ Uploaded ${relativePath} (${(result.size / 1024).toFixed(2)} KB)`,
        );
        successCount++;
        totalSize += result.size;
      } else {
        console.error(`✗ Failed to upload ${relativePath}: ${result.error}`);
        await publishLog(`✗ Failed to upload ${relativePath}: ${result.error}`);
        failureCount++;
        failedFiles.push({
          file: relativePath,
          error: result.error,
          errorCode: result.errorCode,
        });
      }
    });

    await Promise.all(uploadPromises);

    const processed = Math.min(i + batchSize, files.length);
    console.log(`Progress: ${processed}/${files.length} files processed`);
    await publishLog(`Progress: ${processed}/${files.length} files processed`);
  }

  console.log(
    `Upload summary: ${successCount} successful, ${failureCount} failed`,
  );
  console.log(
    `Total size uploaded: ${(totalSize / 1024 / 1024).toFixed(2)} MB`,
  );
  await publishLog(
    `Upload summary: ${successCount} successful, ${failureCount} failed`,
  );
  await publishLog(
    `Total size uploaded: ${(totalSize / 1024 / 1024).toFixed(2)} MB`,
  );

  if (failedFiles.length > 0) {
    console.log("\nFailed files details:");
    await publishLog("Failed files details:");
    const errorSummary = {};
    failedFiles.forEach((failedFile) => {
      console.log(`  - ${failedFile.file}: ${failedFile.error}`);
      const errorType = failedFile.errorCode || "Unknown";
      errorSummary[errorType] = (errorSummary[errorType] || 0) + 1;
    });

    console.log("\nError summary:");
    await publishLog("Error summary:");
    Object.entries(errorSummary).forEach(([errorType, count]) => {
      console.log(`  - ${errorType}: ${count} files`);
      publishLog(`  - ${errorType}: ${count} files`);
    });
  }

  if (failureCount > 0) {
    throw new Error(
      `Failed to upload ${failureCount} out of ${files.length} files. Check logs for details.`,
    );
  }

  return {
    totalFiles: files.length,
    successCount,
    failureCount,
    totalSize,
  };
}

// Helper function to get all files recursively with better filtering
function getAllFiles(dirPath, arrayOfFiles = []) {
  if (!fs.existsSync(dirPath)) {
    console.warn(`Directory does not exist: ${dirPath}`);
    return arrayOfFiles;
  }

  const files = fs.readdirSync(dirPath);
  files.forEach((file) => {
    const fullPath = path.join(dirPath, file);
    try {
      const stats = fs.statSync(fullPath);
      if (stats.isDirectory()) {
        if (
          ![
            "node_modules",
            ".git",
            ".svn",
            "__pycache__",
            ".DS_Store",
          ].includes(file)
        ) {
          arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
        }
      } else {
        if (
          !file.startsWith(".") &&
          !file.endsWith(".map.tmp") &&
          file !== ".DS_Store"
        ) {
          arrayOfFiles.push(fullPath);
        }
      }
    } catch (error) {
      console.warn(`Could not process ${fullPath}: ${error.message}`);
    }
  });

  return arrayOfFiles;
}

// Function to test S3 connection with more detailed diagnostics
async function testS3Connection() {
  try {
    console.log("Testing S3 connection...");
    await publishLog("Testing S3 connection...");

    const command = new ListObjectsV2Command({
      Bucket: "vercel-deploy-obj",
      MaxKeys: 1,
    });

    const response = await s3Client.send(command);
    console.log("✓ S3 connection test successful");
    console.log(`✓ Bucket accessible, region: ${AWS_REGION}`);
    await publishLog("✓ S3 connection test successful");
    await publishLog(`✓ Bucket accessible, region: ${AWS_REGION}`);

    // Test write permissions
    try {
      const testKey = `__test/${PROJECT_ID}/connection-test-${Date.now()}.txt`;
      const testCommand = new PutObjectCommand({
        Bucket: "vercel-deploy-obj",
        Key: testKey,
        Body: "Connection test",
        ContentType: "text/plain",
      });

      await s3Client.send(testCommand);
      console.log("✓ S3 write permissions verified");
      await publishLog("✓ S3 write permissions verified");

      // Clean up test file
      try {
        const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
        await s3Client.send(
          new DeleteObjectCommand({
            Bucket: "vercel-deploy-obj",
            Key: testKey,
          }),
        );
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
    } catch (writeError) {
      console.warn("⚠ Write permission test failed:", writeError.message);
      await publishLog(
        `⚠ Write permission test failed: ${writeError.message}`,
      );
    }

    return true;
  } catch (error) {
    console.error("✗ S3 connection test failed:", error.message);
    await publishLog(`✗ S3 connection test failed: ${error.message}`);

    if (error.name === "CredentialsProviderError") {
      console.error("  → Check AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY");
      await publishLog("  → Check AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY");
    } else if (error.name === "NoSuchBucket") {
      console.error(
        "  → Bucket 'vercel-deploy-obj' does not exist or is in wrong region",
      );
      await publishLog(
        "  → Bucket 'vercel-deploy-obj' does not exist or is in wrong region",
      );
    } else if (error.name === "AccessDenied") {
      console.error("  → AWS credentials lack necessary S3 permissions");
      await publishLog("  → AWS credentials lack necessary S3 permissions");
    } else if (error.name === "NetworkingError") {
      console.error("  → Network connectivity issue");
      await publishLog("  → Network connectivity issue");
    }

    return false;
  }
}

// Main initialization function
async function init() {
  let kafkaConnected = false;

  try {
    console.log("Starting deployment process...");
    console.log(`PROJECT_ID: ${PROJECT_ID}`);
    console.log(`DEPLOYMENT_ID: ${DEPLOYMENT_ID}`);
    console.log(`GIT_URL: ${GIT_URL}`);

    // Connect to Kafka producer
    await producer.connect();
    kafkaConnected = true;
    await publishLog("Build started");
    console.log("✓ Connected to Kafka");

    // Test S3 connection before proceeding
    const s3Connected = await testS3Connection();
    if (!s3Connected) {
      throw new Error(
        "S3 connection failed - check AWS credentials and permissions",
      );
    }

    const outputDir = path.join(__dirname, "output");

    // Clean output directory if it exists
    if (fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true, force: true });
      console.log("✓ Cleaned output directory");
    }

    // Clone the repository
    await publishLog("Cloning repository...");
    await cloneRepository(GIT_URL, outputDir);
    await publishLog("Repository cloned successfully");
    console.log("✓ Repository cloned successfully");

    // Build the project
    await publishLog("Starting build process...");
    await buildProject(outputDir);
    await publishLog("Build completed successfully");
    console.log("✓ Build completed successfully");

    // Find build output directory
    const possiblePaths = [
      path.join(outputDir, "dist"),
      path.join(outputDir, "build"),
      path.join(outputDir, "public"),
      path.join(outputDir, "out"),
      path.join(outputDir, "_site"),
    ];

    let finalDistPath = null;
    for (const possiblePath of possiblePaths) {
      if (fs.existsSync(possiblePath)) {
        finalDistPath = possiblePath;
        break;
      }
    }

    if (!finalDistPath) {
      const availableDirs = fs
        .readdirSync(outputDir)
        .filter((item) =>
          fs.statSync(path.join(outputDir, item)).isDirectory(),
        );
      const errorMsg = `No build output found. Checked: ${possiblePaths.map((p) => path.basename(p)).join(", ")}. Available directories: ${availableDirs.join(", ")}`;
      console.error(errorMsg);
      await publishLog(errorMsg);
      throw new Error(errorMsg);
    }

    await publishLog(`Found build output in ${path.basename(finalDistPath)}`);
    console.log(`✓ Found build output in ${path.basename(finalDistPath)}`);

    // Upload to S3
    const files = getAllFiles(finalDistPath);
    if (files.length === 0) {
      throw new Error(`No files found in build directory: ${finalDistPath}`);
    }

    await publishLog(`Found ${files.length} files to upload`);
    const uploadResult = await uploadToS3(finalDistPath, PROJECT_ID);

    await publishLog(
      `Deployment completed successfully! Uploaded ${uploadResult.successCount} files (${(uploadResult.totalSize / 1024 / 1024).toFixed(2)} MB)`,
    );
    console.log("✓ Deployment completed successfully!");
  } catch (error) {
    console.error("Deployment failed:", error);
    if (kafkaConnected) {
      await publishLog(`Deployment failed: ${error.message}`);
    }
    process.exit(1);
  } finally {
    if (kafkaConnected) {
      try {
        await producer.disconnect();
        console.log("✓ Disconnected from Kafka");
      } catch (error) {
        console.error("Error disconnecting from Kafka:", error);
      }
    }
    process.exit(0);
  }
}

// Handle uncaught exceptions
process.on("uncaughtException", async (error) => {
  console.error("Uncaught Exception:", error);
  try {
    await publishLog(`Uncaught Exception: ${error.message}`);
  } catch (logError) {
    console.error("Failed to log uncaught exception:", logError);
  }
  process.exit(1);
});

process.on("unhandledRejection", async (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  try {
    await publishLog(`Unhandled Rejection: ${reason}`);
  } catch (logError) {
    console.error("Failed to log unhandled rejection:", logError);
  }
  process.exit(1);
});

// Start the process
init().catch(async (error) => {
  console.error("Fatal error:", error);
  try {
    await publishLog(`Fatal error: ${error.message}`);
  } catch (logError) {
    console.error("Failed to log fatal error:", logError);
  }
  process.exit(1);
});
