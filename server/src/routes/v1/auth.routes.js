import express from "express";
import dependencies from "../../Dependencies/dependencies.js";
import authenticate from "../../middlewares/authenticate.js";
import authorize from "../../middlewares/authorize.js";
import validate from "../../middlewares/validate.js";

import { APPLICATION_ROLES } from "../../constants/role.js";
import requestLogger from "../../middlewares/request.logger.js";
import { loginSchema, onboardSuperAdminSchema, registrationSchema } from "../../validators/auth.validator.js";

const authRouter = express.Router();
const { controller } = dependencies;
const authController = controller.authController

authRouter.post("/onboard-super-admin",
    requestLogger,
    validate(onboardSuperAdminSchema),
    (req, res, next) => authController.onboardSuperAdmin(req, res, next)
)

authRouter.post("/register",
    requestLogger,
    authenticate,
    authorize([APPLICATION_ROLES.SUPER_ADMIN]),
    validate(registrationSchema),
    (req, res, next) => authController.register(req, res, next)
)

authRouter.post("/login",
    requestLogger,
    validate(loginSchema),
    (req, res, next) => authController.login(req, res, next)
);

authRouter.get("/profile",
    requestLogger,
    authenticate,
    (req, res, next) => authController.getProfile(req, res, next)
)

authRouter.get("/logout",
    requestLogger,
    (req, res, next) => authController.logout(req, res, next)
)

export default authRouter
