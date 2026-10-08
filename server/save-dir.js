import fs from 'fs';

export function createSaveDirStore(saveDirFile) {
  return {
    read() {
      try {
        const j = JSON.parse(fs.readFileSync(saveDirFile, 'utf8'));
        if (j.path && fs.existsSync(j.path)) return j.path;
      } catch {}
      return '';
    },
    write(dir) { fs.writeFileSync(saveDirFile, JSON.stringify({ path: dir })); },
  };
}
