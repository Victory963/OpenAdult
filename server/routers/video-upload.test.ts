import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { videoUploadRouter } from "./video-upload";

describe("Video Upload Router", () => {
  let sessionId: string;

  describe("initSession", () => {
    it("should initialize upload session with valid file", async () => {
      const caller = videoUploadRouter.createCaller({
        user: { id: 1, role: "admin" },
        req: {} as any,
        res: {} as any,
      } as any);

      const result = await caller.initSession({
        fileName: "test-video.mp4",
        fileSize: 1024 * 1024 * 100, // 100MB
        totalChunks: 20,
      });

      expect(result.sessionId).toBeDefined();
      expect(result.message).toBe("Upload session initialized");
      sessionId = result.sessionId;
    });

    it("should reject non-admin users", async () => {
      const caller = videoUploadRouter.createCaller({
        user: { id: 1, role: "user" },
        req: {} as any,
        res: {} as any,
      } as any);

      try {
        await caller.initSession({
          fileName: "test-video.mp4",
          fileSize: 1024 * 1024 * 100,
          totalChunks: 20,
        });
        expect.fail("Should have thrown error");
      } catch (error: any) {
        expect(error.code).toBe("FORBIDDEN");
      }
    });

    it("should reject files exceeding 100GB limit", async () => {
      const caller = videoUploadRouter.createCaller({
        user: { id: 1, role: "admin" },
        req: {} as any,
        res: {} as any,
      } as any);

      try {
        await caller.initSession({
          fileName: "huge-video.mp4",
          fileSize: 101 * 1024 * 1024 * 1024, // 101GB
          totalChunks: 20000,
        });
        expect.fail("Should have thrown error");
      } catch (error: any) {
        expect(error.code).toBe("BAD_REQUEST");
        expect(error.message).toContain("100GB");
      }
    });

    it("should reject unsupported file formats", async () => {
      const caller = videoUploadRouter.createCaller({
        user: { id: 1, role: "admin" },
        req: {} as any,
        res: {} as any,
      } as any);

      try {
        await caller.initSession({
          fileName: "document.pdf",
          fileSize: 1024 * 1024 * 100,
          totalChunks: 20,
        });
        expect.fail("Should have thrown error");
      } catch (error: any) {
        expect(error.code).toBe("BAD_REQUEST");
        expect(error.message).toContain("not supported");
      }
    });
  });

  describe("uploadChunk", () => {
    beforeEach(async () => {
      const caller = videoUploadRouter.createCaller({
        user: { id: 1, role: "admin" },
        req: {} as any,
        res: {} as any,
      } as any);

      const result = await caller.initSession({
        fileName: "test-video.mp4",
        fileSize: 1024 * 1024 * 100,
        totalChunks: 3,
      });
      sessionId = result.sessionId;
    });

    it("should upload chunk successfully", async () => {
      const caller = videoUploadRouter.createCaller({
        user: { id: 1, role: "admin" },
        req: {} as any,
        res: {} as any,
      } as any);

      const chunkData = Buffer.from("test chunk data").toString("base64");
      const result = await caller.uploadChunk({
        sessionId,
        chunkIndex: 0,
        chunkData,
      });

      expect(result.success).toBe(true);
      expect(result.chunkIndex).toBe(0);
      expect(result.uploadedChunks).toBe(1);
      expect(result.totalChunks).toBe(3);
      expect(result.progress).toBe(33); // 1/3 = 33%
    });

    it("should track upload progress correctly", async () => {
      const caller = videoUploadRouter.createCaller({
        user: { id: 1, role: "admin" },
        req: {} as any,
        res: {} as any,
      } as any);

      const chunkData = Buffer.from("test chunk data").toString("base64");

      // Upload first chunk
      await caller.uploadChunk({
        sessionId,
        chunkIndex: 0,
        chunkData,
      });

      // Upload second chunk
      const result = await caller.uploadChunk({
        sessionId,
        chunkIndex: 1,
        chunkData,
      });

      expect(result.uploadedChunks).toBe(2);
      expect(result.progress).toBe(67); // 2/3 = 66.67% rounded to 67%
    });

    it("should reject invalid session ID", async () => {
      const caller = videoUploadRouter.createCaller({
        user: { id: 1, role: "admin" },
        req: {} as any,
        res: {} as any,
      } as any);

      try {
        await caller.uploadChunk({
          sessionId: "invalid-session",
          chunkIndex: 0,
          chunkData: Buffer.from("test").toString("base64"),
        });
        expect.fail("Should have thrown error");
      } catch (error: any) {
        expect(error.code).toBe("BAD_REQUEST");
      }
    });
  });

  describe("getProgress", () => {
    beforeEach(async () => {
      const caller = videoUploadRouter.createCaller({
        user: { id: 1, role: "admin" },
        req: {} as any,
        res: {} as any,
      } as any);

      const result = await caller.initSession({
        fileName: "test-video.mp4",
        fileSize: 1024 * 1024 * 100,
        totalChunks: 5,
      });
      sessionId = result.sessionId;
    });

    it("should return upload progress", async () => {
      const caller = videoUploadRouter.createCaller({
        user: { id: 1, role: "admin" },
        req: {} as any,
        res: {} as any,
      } as any);

      const chunkData = Buffer.from("test chunk data").toString("base64");
      await caller.uploadChunk({
        sessionId,
        chunkIndex: 0,
        chunkData,
      });

      const progress = await caller.getProgress({ sessionId });

      expect(progress.uploadedChunks).toBe(1);
      expect(progress.totalChunks).toBe(5);
      expect(progress.progress).toBe(20);
      expect(progress.status).toBe("uploading");
    });

    it("should return not_found for invalid session", async () => {
      const caller = videoUploadRouter.createCaller({
        user: { id: 1, role: "admin" },
        req: {} as any,
        res: {} as any,
      } as any);

      const progress = await caller.getProgress({ sessionId: "invalid" });

      expect(progress.status).toBe("not_found");
      expect(progress.progress).toBe(0);
    });
  });

  describe("cancelUpload", () => {
    beforeEach(async () => {
      const caller = videoUploadRouter.createCaller({
        user: { id: 1, role: "admin" },
        req: {} as any,
        res: {} as any,
      } as any);

      const result = await caller.initSession({
        fileName: "test-video.mp4",
        fileSize: 1024 * 1024 * 100,
        totalChunks: 5,
      });
      sessionId = result.sessionId;
    });

    it("should cancel upload session", async () => {
      const caller = videoUploadRouter.createCaller({
        user: { id: 1, role: "admin" },
        req: {} as any,
        res: {} as any,
      } as any);

      const result = await caller.cancelUpload({ sessionId });

      expect(result.success).toBe(true);
      expect(result.message).toBe("Upload cancelled");

      // Verify session is deleted
      const progress = await caller.getProgress({ sessionId });
      expect(progress.status).toBe("not_found");
    });
  });

  describe("File format validation", () => {
    it("should accept all supported video formats", async () => {
      const caller = videoUploadRouter.createCaller({
        user: { id: 1, role: "admin" },
        req: {} as any,
        res: {} as any,
      } as any);

      const formats = [".mp4", ".webm", ".mkv", ".avi", ".mov", ".flv", ".wmv", ".m4v"];

      for (const format of formats) {
        const result = await caller.initSession({
          fileName: `video${format}`,
          fileSize: 1024 * 1024 * 100,
          totalChunks: 20,
        });
        expect(result.sessionId).toBeDefined();
      }
    });
  });
});
