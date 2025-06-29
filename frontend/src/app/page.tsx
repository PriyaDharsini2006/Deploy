"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Github } from "lucide-react";
import { Fira_Code } from "next/font/google";
import axios from "axios";
const socket = io("http://localhost:9000");

const firaCode = Fira_Code({ subsets: ["latin"] });

export default function Home() {
  const [repoURL, setURL] = useState<string>("");
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [projectId, setProjectId] = useState<string | undefined>();
  const [deployPreviewURL, setDeployPreviewURL] = useState<
    string | undefined
  >();
  const logContainerRef = useRef<HTMLElement>(null);

  const isValidURL: [boolean, string | null] = useMemo(() => {
    if (!repoURL.trim()) return [false, null];
    const regex = /^(?:https?:\/\/)?(?:www\.)?github\.com\/[^\/]+\/[^\/]+\/?$/;
    return [regex.test(repoURL), "Enter a valid GitHub Repository URL"];
  }, [repoURL]);

  const handleClickDeploy = useCallback(async () => {
    setLoading(true);
    setLogs([]);
    try {
      console.log("Sending deploy request with repo:", repoURL);

      const response = await axios.post(`http://localhost:9000/project`, {
        gitUrl: repoURL,
      });

      if (response.data?.data) {
        const { projSlug, url } = response.data.data;
        setProjectId(projSlug);
        setDeployPreviewURL(url);

        console.log(`Subscribing to logs:${projSlug}`);
        socket.emit("subscribe", `logs:${projSlug}`);
      }
    } catch (error) {
      console.error("🚨 Deployment request failed:", error);
    } finally {
      setLoading(false);
    }
  }, [repoURL]);

  const handleSocketIncomingMessage = useCallback((message: any) => {
    console.log("Received socket message:", message);
    try {
      let logMessage: string;

      if (typeof message === "string") {
        logMessage = message;
      } else if (message && typeof message === "object") {
        logMessage = message.log || JSON.stringify(message);
      } else {
        logMessage = String(message);
      }
      setLogs((prev) => {
        const newLogs = [...prev, logMessage];
        console.log("Updated logs:", newLogs);
        return newLogs;
      });
      setTimeout(() => {
        logContainerRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 100);
    } catch (err) {
      console.error("Error processing socket message:", err, message);
    }
  }, []);

  useEffect(() => {
    socket.on("log", handleSocketIncomingMessage);

    socket.on("connect", () => {
      console.log("Socket connected:", socket.id);
    });

    socket.on("disconnect", () => {
      console.log("Socket disconnected");
    });

    socket.on("subscribed", (message) => {
      console.log("Subscription confirmed:", message);
    });

    return () => {
      socket.off("log", handleSocketIncomingMessage);
      socket.off("connect");
      socket.off("disconnect");
      socket.off("subscribed");
    };
  }, [handleSocketIncomingMessage]);

  return (
    <main className="flex justify-center items-center h-[100vh] bg-gray-900 text-white">
      <div className="w-[600px]">
        <span className="flex justify-start items-center gap-2">
          <Github className="text-5xl" />
          <Input
            disabled={loading}
            value={repoURL}
            onChange={(e) => setURL(e.target.value)}
            type="url"
            placeholder="GitHub Repo URL (e.g., https://github.com/user/repo)"
          />
        </span>
        <Button
          onClick={handleClickDeploy}
          disabled={!isValidURL[0] || loading}
          className="w-full mt-3"
        >
          {loading ? "In Progress..." : "Deploy"}
        </Button>

        {projectId && (
          <div className="mt-2 text-sm text-gray-400">
            Project ID: {projectId} | Logs count: {logs.length}
          </div>
        )}

        {deployPreviewURL && (
          <div className="mt-4 bg-slate-800 py-3 px-4 rounded-lg">
            <p>
              Preview URL:{" "}
              <a
                href={deployPreviewURL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sky-400 underline"
              >
                {deployPreviewURL}
              </a>
            </p>
          </div>
        )}

        {logs.length > 0 && (
          <div
            className={`${firaCode.className} text-sm text-green-500 logs-container mt-5 border-green-500 border-2 rounded-lg p-4 h-[300px] overflow-y-auto`}
          >
            <pre className="flex flex-col gap-1">
              {logs.map((log, i) => (
                <code
                  ref={logs.length - 1 === i ? logContainerRef : undefined}
                  key={i}
                >
                  {`> ${log}`}
                </code>
              ))}
            </pre>
          </div>
        )}
      </div>
    </main>
  );
}
