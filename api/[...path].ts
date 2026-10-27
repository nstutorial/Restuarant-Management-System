import { app } from '../server/src/index.js';

export default function handler(request: any, response: any) {
  return app(request as never, response as never);
}
