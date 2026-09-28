// The Claude connector: a remote MCP server at /mcp, plus the OAuth 2.1
// authorization server Claude signs in through. See mcp/README.md.

import { fs } from '@/utils/firebase'
import { createMcpApp } from './app'
import { firebaseBackend } from './firebaseBackend'
import { firestoreStore } from './firestoreStore'
import { createOAuthService } from './oauthService'

export const oauthService = createOAuthService(firestoreStore(fs))

export const mcpApp = createMcpApp({ oauth: oauthService, backend: firebaseBackend })
