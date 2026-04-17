const AuthState = require('../models/AuthState');

/**
 * MongoDB Store for RemoteAuth
 * Stores WhatsApp authentication state in MongoDB
 */
const MongoStore = {
  /**
   * Check if session exists in store
   */
  async sessionExists({ session }) {
    try {
      console.log(`🔍 Checking if session exists in MongoDB: ${session}`);
      const record = await AuthState.findOne({ sessionId: session });
      const exists = !!record;
      console.log(`📋 Session ${session} ${exists ? 'FOUND' : 'NOT FOUND'} in MongoDB`);
      return exists;
    } catch (err) {
      console.error(`❌ MongoStore sessionExists error:`, err.message);
      return false;
    }
  },

  /**
   * Save authentication state
   */
  async save({ session, state }) {
    try {
      console.log(`💾 Saving auth state to MongoDB for session: ${session}`);
      
      // Log state size for debugging
      const stateSize = JSON.stringify(state).length;
      console.log(`📦 State size: ${Math.round(stateSize / 1024)}KB`);
      
      const result = await AuthState.findOneAndUpdate(
        { sessionId: session },
        { 
          sessionId: session,
          state: state, 
          updatedAt: new Date() 
        },
        { upsert: true, new: true }
      );
      
      console.log(`✅ Auth state saved to MongoDB for session: ${session}`);
      return true;
    } catch (err) {
      console.error(`❌ MongoStore save error:`, err.message);
      throw err;
    }
  },

  /**
   * Load authentication state
   */
  async load({ session }) {
    try {
      console.log(`📂 Loading auth state from MongoDB for session: ${session}`);
      
      const record = await AuthState.findOne({ sessionId: session });
      
      if (record && record.state) {
        console.log(`✅ Auth state loaded from MongoDB for session: ${session}`);
        
        // Validate state has required properties
        if (typeof record.state === 'object') {
          return record.state;
        } else {
          console.error(`❌ Invalid state format in MongoDB for session: ${session}`);
          return null;
        }
      }
      
      console.log(`📭 No auth state found in MongoDB for session: ${session}`);
      return null;
    } catch (err) {
      console.error(`❌ MongoStore load error:`, err.message);
      return null;
    }
  },

  /**
   * Delete authentication state
   */
  async delete({ session }) {
    try {
      console.log(`🗑️ Deleting auth state from MongoDB for session: ${session}`);
      const result = await AuthState.deleteOne({ sessionId: session });
      console.log(`✅ Deleted ${result.deletedCount} auth state(s) for session: ${session}`);
    } catch (err) {
      console.error(`❌ MongoStore delete error:`, err.message);
      throw err;
    }
  }
};

module.exports = MongoStore;