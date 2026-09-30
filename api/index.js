import '../server/tz.js';
import { handle } from '../server/app.js';

export default function handler(req, res) {
  return handle(req, res);
}
