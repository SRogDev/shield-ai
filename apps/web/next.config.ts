import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@shield/shared"],
};

export default withWorkflow(config);
