import "./http/index";
import { wireIntegrations } from "./be/wiring.ts";

// Subscribe integrations (e.g. VCS reactions) to task lifecycle hooks. Runs
// after module evaluation, before any task can be claimed over the network.
wireIntegrations();
