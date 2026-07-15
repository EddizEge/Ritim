const repository = process.env.RITIM_GITHUB_REPOSITORY || process.env.GITHUB_REPOSITORY || 'EddizEge/Ritim'
const [owner, repo] = repository.split('/')

module.exports = {
  appId: 'app.ritim.desktop',
  productName: 'Ritim',
  artifactName: 'Ritim-Setup-${version}.${ext}',
  files: ['dist/**/*', 'electron/**/*', 'package.json'],
  directories: { output: process.env.RITIM_RELEASE_DIR || 'release' },
  win: { target: 'nsis', icon: 'build/icon.ico' },
  nsis: {
    oneClick: true,
    perMachine: false,
    include: 'build/installer.nsh',
  },
  publish: [{ provider: 'github', owner, repo, releaseType: 'release' }],
  electronUpdaterCompatibility: '>=2.16',
}
