// context/DeployContext.jsx
// Lifts DeployModal to the App root so it is never inside a display:none subtree.
// Any page can call openDeploy(entry) to show the modal.

import React, { createContext, useContext, useState, useCallback } from "react";
import DeployModal from "../components/DeployModal";
import { useContainer } from "./ContainerContext";

const DeployContext = createContext({ openDeploy: () => {}, bgDeployId: null });

export function useDeployContext() {
  return useContext(DeployContext);
}

export function DeployProvider({ children }) {
  const { tools: liveTools } = useContainer();

  // deployTarget = entry loaded in modal (kept even when hidden, so deploy continues)
  // modalVisible = whether the backdrop is shown
  const [deployTarget, setDeployTarget] = useState(null);
  const [modalVisible, setModalVisible] = useState(false);

  const openDeploy = useCallback((entry) => {
    if (deployTarget && deployTarget.id === entry.id) {
      // Re-show existing modal for this entry (background deploy in progress)
      setModalVisible(true);
    } else {
      setDeployTarget(entry);
      setModalVisible(true);
    }
  }, [deployTarget]);

  const handleDismiss = useCallback(() => {
    // Hide backdrop but keep modal mounted → deploy continues
    setModalVisible(false);
  }, []);

  const handleClose = useCallback(() => {
    setDeployTarget(null);
    setModalVisible(false);
  }, []);

  // ID of any tool whose deploy is running in the background
  const bgDeployId = (!modalVisible && deployTarget) ? deployTarget.id : null;

  function getLiveTool(entry) {
    return liveTools.find(t => t.id === entry?.id);
  }

  return (
    <DeployContext.Provider value={{ openDeploy, bgDeployId }}>
      {children}

      {/* Modal lives here at the root — never inside a display:none subtree */}
      {deployTarget && (
        <DeployModal
          key={deployTarget.id}
          entry={deployTarget}
          liveTool={getLiveTool(deployTarget)}
          visible={modalVisible}
          onDismiss={handleDismiss}
          onClose={handleClose}
        />
      )}
    </DeployContext.Provider>
  );
}
