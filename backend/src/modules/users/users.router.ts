import { Router } from 'express';
import { asyncHandler } from '../../common/asyncHandler.js';
import { authenticate, requireRole } from '../auth/auth.middleware.js';
import { createUserSchema, updateUserSchema, listUsersQuerySchema, idParamSchema } from './users.schemas.js';
import * as usersService from './users.service.js';

export const usersRouter = Router();

usersRouter.use(authenticate, requireRole('SUPER_ADMIN'));

function parseId(raw: string): string {
  return idParamSchema.parse(raw);
}

usersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = listUsersQuerySchema.parse(req.query);
    res.json(await usersService.listUsers(query));
  }),
);

usersRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createUserSchema.parse(req.body);
    const user = await usersService.createUser(body, req.auth!.userId, req.ip ?? null);
    res.status(201).json({ user });
  }),
);

usersRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = updateUserSchema.parse(req.body);
    const user = await usersService.updateUser(parseId(req.params.id ?? ""), body, req.auth!.userId, req.ip ?? null);
    res.json({ user });
  }),
);

usersRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await usersService.deleteUser(parseId(req.params.id ?? ""), req.auth!.userId, req.ip ?? null);
    res.json({ message: 'User deleted' });
  }),
);
