import express from "express";
import authRouter from "./auth.routes.js";

/**
 * API v1 router
 */
const v1Router = express.Router();

// Core routes
v1Router.use("/auth", authRouter);

export default v1Router;
