import { createContext } from 'react';

/**
 * The session the messages on screen belong to, when it is not the open one: a sub-agent's in its sheet. What a
 * step loads on demand (the rest of a long output) comes from that session, which holds the call.
 */
export const OwnerSession = createContext<string | undefined>(undefined);
