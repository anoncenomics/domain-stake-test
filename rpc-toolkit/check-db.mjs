import { open } from 'sqlite';
import sqlite3 from 'sqlite3';

async function checkDatabase() {
  try {
    const db = await open({
      filename: 'public/data/comprehensive-metrics.db',
      driver: sqlite3.Database
    });

    // Check basic stats
    const stats = await db.get('SELECT COUNT(*) as count, MIN(epoch) as min_epoch, MAX(epoch) as max_epoch FROM epochs');
    console.log('Database Stats:', stats);

    // Check recent epochs
    const recent = await db.all('SELECT epoch, timestamp, created_at FROM epochs ORDER BY epoch DESC LIMIT 10');
    console.log('\nRecent Epochs:');
    recent.forEach(row => {
      const date = new Date(row.timestamp);
      console.log(`  Epoch ${row.epoch}: ${date.toISOString()} (created: ${row.created_at})`);
    });

    // Check for any errors or incomplete data
    const sample = await db.get('SELECT data FROM epochs ORDER BY epoch DESC LIMIT 1');
    if (sample) {
      const data = JSON.parse(sample.data);
      console.log('\nSample data structure:');
      console.log('  Keys:', Object.keys(data));
      console.log('  Epoch:', data.epoch);
      console.log('  End Block:', data.endBlock);
    }

    await db.close();
  } catch (e) {
    console.error('Database check failed:', e.message);
  }
}

checkDatabase();
