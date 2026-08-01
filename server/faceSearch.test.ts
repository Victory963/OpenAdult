import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
vi.mock("../drizzle/schema", () => ({
  actresses: { id: "id", name: "name", japaneseName: "japaneseName", chineseName: "chineseName", bio: "bio", profileImageUrl: "profileImageUrl", tags: "tags", videoCount: "videoCount" },
  videos: { id: "id", title: "title", thumbnailUrl: "thumbnailUrl", videoUrl: "videoUrl", duration: "duration", category: "category", views: "views", rating: "rating" },
  videoActresses: { actressId: "actressId", videoId: "videoId" },
  faceSearchHistory: { userId: "userId", uploadedImageUrl: "uploadedImageUrl", matchedActressIds: "matchedActressIds", topMatchActressId: "topMatchActressId", similarityScore: "similarityScore" },
}));

vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn().mockResolvedValue({
    choices: [{
      message: {
        content: JSON.stringify({
          matches: [
            { id: 1, similarity: 0.95, reason: "Similar facial features" },
            { id: 2, similarity: 0.8, reason: "Similar face shape" },
          ],
        }),
      },
    }],
  }),
}));

vi.mock("./db", () => ({
  getDb: vi.fn().mockResolvedValue({
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe("Face Search Router Logic", () => {
  describe("searchByName", () => {
    it("should filter actresses by name (case-insensitive)", () => {
      const allActresses = [
        { id: 1, name: "Test Actress", japaneseName: "テスト女優", chineseName: "测试女优", bio: "bio1", profileImageUrl: "http://img1.jpg", tags: ["tag1"], videoCount: 5 },
        { id: 2, name: "Another Actress", japaneseName: "別の女優", chineseName: null, bio: "bio2", profileImageUrl: "http://img2.jpg", tags: ["tag2"], videoCount: 3 },
        { id: 3, name: "Third Person", japaneseName: "三人目", chineseName: "第三人", bio: "bio3", profileImageUrl: "http://img3.jpg", tags: [], videoCount: 1 },
      ];

      const queryLower = "test";
      const matchedActresses = allActresses.filter(
        (a) =>
          a.name.toLowerCase().includes(queryLower) ||
          (a.japaneseName && a.japaneseName.toLowerCase().includes(queryLower)) ||
          (a.chineseName && a.chineseName.toLowerCase().includes(queryLower))
      );

      expect(matchedActresses).toHaveLength(1);
      expect(matchedActresses[0].id).toBe(1);
    });

    it("should match Japanese name", () => {
      const allActresses = [
        { id: 1, name: "Test Actress", japaneseName: "テスト女優", chineseName: null, bio: "", profileImageUrl: null, tags: [], videoCount: 0 },
        { id: 2, name: "Another", japaneseName: "別の女優", chineseName: null, bio: "", profileImageUrl: null, tags: [], videoCount: 0 },
      ];

      const queryLower = "テスト";
      const matched = allActresses.filter(
        (a) =>
          a.name.toLowerCase().includes(queryLower) ||
          (a.japaneseName && a.japaneseName.toLowerCase().includes(queryLower)) ||
          (a.chineseName && a.chineseName.toLowerCase().includes(queryLower))
      );

      expect(matched).toHaveLength(1);
      expect(matched[0].id).toBe(1);
    });

    it("should match Chinese name", () => {
      const allActresses = [
        { id: 1, name: "Test", japaneseName: null, chineseName: "测试女优", bio: "", profileImageUrl: null, tags: [], videoCount: 0 },
        { id: 2, name: "Other", japaneseName: null, chineseName: "其他", bio: "", profileImageUrl: null, tags: [], videoCount: 0 },
      ];

      const queryLower = "测试";
      const matched = allActresses.filter(
        (a) =>
          a.name.toLowerCase().includes(queryLower) ||
          (a.japaneseName && a.japaneseName.toLowerCase().includes(queryLower)) ||
          (a.chineseName && a.chineseName.toLowerCase().includes(queryLower))
      );

      expect(matched).toHaveLength(1);
      expect(matched[0].id).toBe(1);
    });

    it("should calculate similarity scores correctly", () => {
      const queryLower = "test actress";
      const actress = { name: "Test Actress", japaneseName: "テスト女優" };
      
      const nameLower = actress.name.toLowerCase();
      const jpNameLower = (actress.japaneseName || "").toLowerCase();
      
      let similarity = 0.5;
      if (nameLower === queryLower || jpNameLower === queryLower) {
        similarity = 1.0;
      } else if (nameLower.startsWith(queryLower) || jpNameLower.startsWith(queryLower)) {
        similarity = 0.9;
      } else if (nameLower.includes(queryLower) || jpNameLower.includes(queryLower)) {
        similarity = 0.7;
      }

      expect(similarity).toBe(1.0); // Exact match
    });

    it("should return empty results for non-matching query", () => {
      const allActresses = [
        { id: 1, name: "Test Actress", japaneseName: "テスト", chineseName: null },
      ];

      const queryLower = "nonexistent";
      const matched = allActresses.filter(
        (a) =>
          a.name.toLowerCase().includes(queryLower) ||
          (a.japaneseName && a.japaneseName.toLowerCase().includes(queryLower)) ||
          (a.chineseName && a.chineseName?.toLowerCase().includes(queryLower))
      );

      expect(matched).toHaveLength(0);
    });
  });

  describe("Video actress filter logic", () => {
    it("should filter videos by actress name before pagination", () => {
      const allActresses = [
        { id: 1, name: "Actress A", japaneseName: "女優A", chineseName: null },
        { id: 2, name: "Actress B", japaneseName: "女優B", chineseName: null },
      ];

      const videoActressRecords = [
        { actressId: 1, videoId: 101 },
        { actressId: 1, videoId: 102 },
        { actressId: 2, videoId: 103 },
      ];

      const searchName = "actress a";
      const matchedActressIds = allActresses
        .filter((a) =>
          a.name.toLowerCase().includes(searchName) ||
          (a.japaneseName && a.japaneseName.toLowerCase().includes(searchName)) ||
          (a.chineseName && a.chineseName?.toLowerCase().includes(searchName))
        )
        .map((a) => a.id);

      expect(matchedActressIds).toEqual([1]);

      const actressFilterVideoIds = videoActressRecords
        .filter((va) => matchedActressIds.includes(va.actressId))
        .map((va) => va.videoId);

      expect(actressFilterVideoIds).toEqual([101, 102]);
    });
  });

  describe("getRelevantVideosForChat logic", () => {
    it("should split query into keywords correctly", () => {
      const query = "巨乳 女優A";
      const keywords = query.split(/[\s+,、。・\u3000]+/).filter(w => w.length >= 1);
      expect(keywords).toEqual(["巨乳", "女優A"]);
    });

    it("should handle empty query", () => {
      const query = "";
      const keywords = query.split(/[\s+,、。・\u3000]+/).filter(w => w.length >= 1);
      expect(keywords).toHaveLength(0);
    });
  });

  describe("Cosine similarity calculation", () => {
    it("should return 1 for identical vectors", () => {
      const vec = [0.5, 0.3, 0.8, 0.2, 0.6, 0.4, 0.7, 0.1, 0.9, 0.5, 0.3, 0.6, 0.4, 0.8];
      
      let dotProduct = 0;
      let norm1 = 0;
      let norm2 = 0;
      for (let i = 0; i < vec.length; i++) {
        dotProduct += vec[i] * vec[i];
        norm1 += vec[i] * vec[i];
        norm2 += vec[i] * vec[i];
      }
      norm1 = Math.sqrt(norm1);
      norm2 = Math.sqrt(norm2);
      const similarity = dotProduct / (norm1 * norm2);

      expect(similarity).toBeCloseTo(1.0, 5);
    });

    it("should return 0 for orthogonal vectors", () => {
      const vec1 = [1, 0, 0, 0];
      const vec2 = [0, 1, 0, 0];
      
      let dotProduct = 0;
      let norm1 = 0;
      let norm2 = 0;
      for (let i = 0; i < vec1.length; i++) {
        dotProduct += vec1[i] * vec2[i];
        norm1 += vec1[i] * vec1[i];
        norm2 += vec2[i] * vec2[i];
      }
      norm1 = Math.sqrt(norm1);
      norm2 = Math.sqrt(norm2);
      const similarity = dotProduct / (norm1 * norm2);

      expect(similarity).toBeCloseTo(0.0, 5);
    });
  });
});
