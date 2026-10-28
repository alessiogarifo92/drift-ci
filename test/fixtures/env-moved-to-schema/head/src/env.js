import { z } from 'zod';

export const env = z.object({ API_URL: z.string().url() }).parse(process.env);
