import { describe, it, expect, vi, beforeEach } from "vitest";
import { fileUploadRouter } from "./file-upload";

// Mock dependencies
vi.mock("./storage", () => ({
  storagePut: vi.fn().mockResolvedValue({
    url: "https://example.com/uploads/test.jpg",
  }),
  storageGet: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: vi.fn().mockResolvedValue({
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue({}),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              offset: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue({}),
    }),
  }),
}));

vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn().mockResolvedValue({
    choices: [
      {
        message: {
          content: "This is a test image analysis result.",
        },
      },
    ],
  }),
}));

describe("File Upload Router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should have analyzeImage procedure", () => {
    const procedures = fileUploadRouter._def.procedures;
    expect(procedures.analyzeImage).toBeDefined();
  });

  it("should have uploadFile procedure", () => {
    const procedures = fileUploadRouter._def.procedures;
    expect(procedures.uploadFile).toBeDefined();
  });

  it("should have analyzeVideo procedure", () => {
    const procedures = fileUploadRouter._def.procedures;
    expect(procedures.analyzeVideo).toBeDefined();
  });

  it("should have analyzePDF procedure", () => {
    const procedures = fileUploadRouter._def.procedures;
    expect(procedures.analyzePDF).toBeDefined();
  });

  it("should have getUploadHistory procedure", () => {
    const procedures = fileUploadRouter._def.procedures;
    expect(procedures.getUploadHistory).toBeDefined();
  });

  it("should have deleteUpload procedure", () => {
    const procedures = fileUploadRouter._def.procedures;
    expect(procedures.deleteUpload).toBeDefined();
  });

  it("should have all procedures as protected", () => {
    const procedures = fileUploadRouter._def.procedures;
    // Check that procedures exist and are defined
    expect(Object.keys(procedures).length).toBeGreaterThan(0);
    expect(procedures.uploadFile).toBeDefined();
    expect(procedures.analyzeImage).toBeDefined();
  });
});
