import { getCube } from "@/cube/cube";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = getCube().handlers;

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PUT = handlers.PUT;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
