import type { NextConfig } from "next";
import { generateDocs } from "./scripts/build-docs";

generateDocs();

const nextConfig: NextConfig = {};

export default nextConfig;
