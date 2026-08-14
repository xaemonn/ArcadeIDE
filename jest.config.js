const { createDefaultPreset } = require("ts-jest");

const tsJestTransformCfg = createDefaultPreset().transform;

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  // The realtime backend has its own test runner (see server/package.json).
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/server/", "<rootDir>/.next/"],
  modulePathIgnorePatterns: ["<rootDir>/server/", "<rootDir>/.next/"],
};
