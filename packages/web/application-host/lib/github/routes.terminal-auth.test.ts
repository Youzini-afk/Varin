import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { registerGitHubRoutes } from './routes.js';

describe('GitHub terminal auth routes', () => {
  it('syncs the active GitHub account into the terminal environment', async () => {
    const app = express();
    app.use(express.json());
    const auth = { accessToken: 'gho_test', user: { login: 'youzini' } };
    const installTerminalGitHubAuth = vi.fn(() => ({
      success: true,
      ghConfigPath: '/home/varin/.config/gh/hosts.yml',
      helperPath: '/home/varin/.config/varin/bin/git-credential-varin-github.cjs',
      gitCredentialHelperConfigured: true,
      gitCredentialHelperError: '',
      gitCredentialHelper: '!"/helper"',
    }));

    registerGitHubRoutes(app, {
      getGitHubLibraries: async () => ({
        getGitHubAuth: () => auth,
        GITHUB_AUTH_FILE: '/home/varin/.config/varin/github-auth.json',
      }),
      installTerminalGitHubAuth,
    });

    const response = await request(app)
      .post('/api/github/auth/terminal')
      .send({ configureGit: false })
      .expect(200);

    expect(installTerminalGitHubAuth).toHaveBeenCalledWith({
      auth,
      authFilePath: '/home/varin/.config/varin/github-auth.json',
      configureGit: false,
    });
    expect(response.body).toEqual({
      success: true,
      ghConfigPath: '/home/varin/.config/gh/hosts.yml',
      helperPath: '/home/varin/.config/varin/bin/git-credential-varin-github.cjs',
      gitCredentialHelperConfigured: true,
      gitCredentialHelperError: '',
    });
  });

  it('rejects terminal sync when GitHub is not connected', async () => {
    const app = express();
    app.use(express.json());

    registerGitHubRoutes(app, {
      getGitHubLibraries: async () => ({ getGitHubAuth: () => null }),
      installTerminalGitHubAuth: vi.fn(),
    });

    const response = await request(app)
      .post('/api/github/auth/terminal')
      .send({})
      .expect(401);

    expect(response.body).toEqual({ error: 'GitHub not connected' });
  });

  it('configures global git author from the active GitHub account', async () => {
    const app = express();
    app.use(express.json());
    const auth = {
      accessToken: 'gho_test',
      user: {
        login: 'youzini-afk',
        id: 12345,
        name: 'youzini',
        email: 'an48934293@gmail.com',
      },
    };
    const configureGitHubGitAuthor = vi.fn(() => ({
      success: true,
      userName: 'youzini',
      userEmail: 'an48934293@gmail.com',
    }));

    registerGitHubRoutes(app, {
      getGitHubLibraries: async () => ({
        getGitHubAuth: () => auth,
      }),
      configureGitHubGitAuthor,
    });

    const response = await request(app)
      .post('/api/github/auth/git-author')
      .send({})
      .expect(200);

    expect(configureGitHubGitAuthor).toHaveBeenCalledWith({ auth });
    expect(response.body).toEqual({
      success: true,
      userName: 'youzini',
      userEmail: 'an48934293@gmail.com',
    });
  });

  it('rejects git author sync when GitHub is not connected', async () => {
    const app = express();
    app.use(express.json());

    registerGitHubRoutes(app, {
      getGitHubLibraries: async () => ({ getGitHubAuth: () => null }),
      configureGitHubGitAuthor: vi.fn(),
    });

    const response = await request(app)
      .post('/api/github/auth/git-author')
      .send({})
      .expect(401);

    expect(response.body).toEqual({ error: 'GitHub not connected' });
  });
});
