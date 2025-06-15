const { execSync } = require('child_process');

import fs from 'fs';
import path from 'path';

// --- Configuration ---
//! Change this values for your setup
const linesToRemove = [
  'ALTER TABLE `PostCoordinates` DROP FOREIGN KEY `PostCoordinates_postId_fkey`;',
  'DROP INDEX `idx_postcoordinates_geo` ON `PostCoordinates`;',
];
// --------------------

function runCommand(command: string) {
  try {
    console.info(`> ${command}`);
    execSync(command, { stdio: 'inherit' });
  } catch (error) {
    console.error(`Command "${command}" failed.`);
    process.exit(1);
  }
}

async function main() {

  const migrationName = process.argv[2]; 
  if (!migrationName) {
    console.error(`Error: Provide migration name. Usage: npm run migrate:safe -- "my-migration-name"`);
    process.exit(1);
  }

  // Step 1: Generate migration file without applying it
  console.info(`\n[Step 1/4] Generating migration file...`);
  runCommand(`npx prisma migrate dev --name "${migrationName}" --create-only`);

  // Step 2: Find the latest migration file
  console.info(`\n[Step 2/4] Searching for migration file...`);
  //! You might need to adjust the path based on your Prisma setup.
  const migrationsDir = path.join(process.cwd(), 'prisma', 'schema' , 'migrations');
  const allMigrations = fs.readdirSync(migrationsDir).sort().reverse();
  //! I use index 1 in allMigrations because last file in my migrations folder is migration_lock.toml.=
  //! Adjust that!
  const latestMigrationDirName = allMigrations[1];
  
  if (!latestMigrationDirName) {
    console.error(`Migration folder not found.`);
    process.exit(1);
  }

  const migrationFilePath = path.join(migrationsDir, latestMigrationDirName, 'migration.sql');
  console.log(`Found: ${migrationFilePath}`);

  // Step 3: Read, clean, and save the migration file
  console.info(`\n[Step 3/4] Cleaning up migration file...`);
  let migrationContent = fs.readFileSync(migrationFilePath, 'utf-8');
  let linesRemovedCount = 0;
  
  linesToRemove.forEach(lineToRemove => {
    const lines = migrationContent.split('\n');
    const originalLength = lines.length;
    const filteredLines = lines.filter(line => !line.includes(lineToRemove));
    
    if (originalLength > filteredLines.length) {
      migrationContent = filteredLines.join('\n');
      linesRemovedCount += originalLength - filteredLines.length;
    }
  });

  if (linesRemovedCount > 0) {
    fs.writeFileSync(migrationFilePath, migrationContent);
    console.info(`Successfully removed ${linesRemovedCount} unwanted lines from the migration file.`);
  } else {
    console.info(`No lines to remove found. The file is clean.`);
  }

  // Step 4: Apply all pending migrations
  console.info(`\n[Step 4/4] Applying migrations...`);
  runCommand('npx prisma migrate deploy');

  console.info(`\n🎉 Safe migration completed successfully!`);
}

main();
