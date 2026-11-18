import { createContext, useContext } from "react";

/**
 * A step's title in the page's language, by the phase its roles run in (the
 * title as the definition writes it): the chat names a loop's steps as the
 * canvas shows them. A phase the loop on the canvas does not have stays as it is.
 */
export const PhaseTitles = createContext<(phase: string) => string>((phase) => phase);
export const usePhaseTitle = (): ((phase: string) => string) => useContext(PhaseTitles);
