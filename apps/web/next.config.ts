import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const config: NextConfig = {
  transpilePackages: ["@shield/shared"],
};

export default withWorkflow(config);
