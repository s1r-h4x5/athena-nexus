// context/NavigationContext.jsx
// Simple context so any page can navigate to any route
// without prop-drilling onCategoryChange all the way down.

import React, { createContext, useContext } from "react";

const NavigationContext = createContext(() => {});

export function NavigationProvider({ onNavigate, children }) {
  return (
    <NavigationContext.Provider value={onNavigate}>
      {children}
    </NavigationContext.Provider>
  );
}

export function useNavigation() {
  return useContext(NavigationContext);
}
