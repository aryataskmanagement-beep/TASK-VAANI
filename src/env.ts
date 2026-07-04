import { readFileSync, existsSync } from 'fs';
import path from 'path';

const firebaseConfigPath = path.join(process.cwd(), 'firebase-applet-config.json');
if (existsSync(firebaseConfigPath)) {
  try {
    const config = JSON.parse(readFileSync(firebaseConfigPath, 'utf-8'));
    if (config.projectId) {
      process.env.GOOGLE_CLOUD_PROJECT = config.projectId;
      process.env.GCLOUD_PROJECT = config.projectId;
      console.log(`[ENV] Bootstrapped Project ID: ${config.projectId}`);
    }
  } catch (e) {
    // Silent fail
  }
}
