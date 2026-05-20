import { createContext, useContext, useState, useCallback, useEffect } from 'react';

const AppContext = createContext(null);

const BATTLE_STORAGE_KEY = 'trapwars_battle_v2';

export function AppProvider({ children }) {
  const [isDegenMode, setIsDegenMode] = useState(false);
  const [toast, setToast] = useState({ msg: '', visible: false });
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [showDegenModal, setShowDegenModal] = useState(false);
  const [battle, setBattleState] = useState(() => {
    try {
      const stored = localStorage.getItem(BATTLE_STORAGE_KEY);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  // Persist battle to localStorage whenever it changes
  useEffect(() => {
    if (battle) {
      localStorage.setItem(BATTLE_STORAGE_KEY, JSON.stringify(battle));
    } else {
      localStorage.removeItem(BATTLE_STORAGE_KEY);
    }
  }, [battle]);

  const setBattle = useCallback((battleOrUpdater) => {
    setBattleState(prev => {
      const next = typeof battleOrUpdater === 'function' ? battleOrUpdater(prev) : battleOrUpdater;
      return next;
    });
  }, []);

  const clearBattle = useCallback(() => {
    setBattleState(null);
    localStorage.removeItem(BATTLE_STORAGE_KEY);
  }, []);

  const showToast = useCallback((msg) => {
    setToast({ msg, visible: true });
    clearTimeout(window.__toastTimer);
    window.__toastTimer = setTimeout(() => setToast(t => ({ ...t, visible: false })), 3000);
  }, []);

  return (
    <AppContext.Provider
      value={{
        isDegenMode,
        setIsDegenMode,
        toast,
        showToast,
        showWalletModal,
        setShowWalletModal,
        showDegenModal,
        setShowDegenModal,
        battle,
        setBattle,
        clearBattle,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export const useApp = () => useContext(AppContext);
