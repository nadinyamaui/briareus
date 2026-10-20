import { describe, it, expect } from 'vitest';
import { outputTail, stripAnsi } from '../lib/command-output.js';

const feed = (lines) => {
  const output = outputTail();
  for (const line of lines) output.push(line);
  return output;
};

// What `php artisan migrate:fresh --seed` printed when TenantSeeder failed, as the
// session log kept it.
const COLLISION = [
  'INFO  Seeding database.',
  'Database\\Seeders\\TenantSeeder ...................................... RUNNING',
  'TypeError',
  'strtolower(): Argument #1 ($string) must be of type string, null given',
  'at vendor/stancl/tenancy/src/Database/Concerns/ConvertsDomainsToLowercase.php:12',
  '8▕ {',
  '9▕     public static function bootConvertsDomainsToLowercase()',
  '10▕     {',
  '11▕         static::saving(function ($model) {',
  '➜  12▕             $model->domain = strtolower($model->domain);',
  '13▕         });',
  '14▕     }',
  '15▕ }',
  '16▕',
  '+17 vendor frames',
  '18  database/seeders/TenantSeeder.php:27',
  'Illuminate\\Database\\Eloquent\\Model::__callStatic()',
  '+8 vendor frames',
  '27  database/seeders/DatabaseSeeder.php:14',
  'Illuminate\\Database\\Seeder::call()',
];

describe('stripAnsi', () => {
  it('drops colour codes', () => {
    expect(stripAnsi('\x1b[2m+17 vendor frames \x1b[22m')).toBe('+17 vendor frames ');
    expect(stripAnsi('\x1b[31;1mERROR\x1b[0m done')).toBe('ERROR done');
  });
});

describe('outputTail', () => {
  it('leads with the exception when only stack frames are left in the tail', () => {
    expect(feed(COLLISION).summary()).toBe(
      'TypeError | strtolower(): Argument #1 ($string) must be of type string, null given | … | ' +
        '18  database/seeders/TenantSeeder.php:27 | Illuminate\\Database\\Eloquent\\Model::__callStatic() | ' +
        '+8 vendor frames | 27  database/seeders/DatabaseSeeder.php:14 | Illuminate\\Database\\Seeder::call()',
    );
  });

  it('still finds the headline once it has scrolled out of the kept lines', () => {
    const lines = ['Illuminate\\Database\\QueryException', 'SQLSTATE[HY000] [2002] Connection refused'];
    for (let i = 0; i < 40; i++) lines.push(`frame ${i}`);
    expect(feed(lines).summary(2)).toBe(
      'Illuminate\\Database\\QueryException | SQLSTATE[HY000] [2002] Connection refused | … | frame 38 | frame 39',
    );
  });

  it('is the plain tail when the error is already in it or there is none', () => {
    expect(feed(['a', 'b', 'Error: Cannot find module x', 'at y']).summary()).toBe(
      'a | b | Error: Cannot find module x | at y',
    );
    expect(feed(['one', 'two', 'three']).summary(2)).toBe('two | three');
  });

  it('does not repeat a message line that is in the tail', () => {
    expect(feed(['fatal: not a git repository', 'hint: run git init', 'done']).summary(2)).toBe(
      'fatal: not a git repository | hint: run git init | done',
    );
  });

  it('keeps the first error report, not a later echo of it', () => {
    const output = feed(['npm ERR! code E404', 'npm ERR! 404 Not Found', 'x', 'y', 'z', 'w', 'v']);
    expect(output.summary()).toBe('npm ERR! code E404 | npm ERR! 404 Not Found | x | y | z | w | v');
  });

  it('does not read stack frames or plain words as headlines', () => {
    const output = feed(['App\\Exceptions\\Handler::render()', 'Errors: 0', 'a', 'b', 'c', 'd', 'e']);
    expect(output.summary()).toBe('a | b | c | d | e');
  });
});
