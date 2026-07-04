export const aiService = {
  async classifyDocument(file: { name: string; base64Data: string; mimeType: string }, businessList: { id: string; name: string; gst?: string }[]): Promise<string> {
    try {
      const response = await fetch('/api/ai/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, businessList })
      });
      if (!response.ok) throw new Error('AI Classification request failed');
      const data = await response.json();
      return data.result || "UNKNOWN";
    } catch (error: any) {
      console.error('AI Classification Error:', error);
      return "UNKNOWN";
    }
  },

  async generateWeeklySummary(logs: string): Promise<string> {
    try {
      const response = await fetch('/api/ai/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logs })
      });
      if (!response.ok) throw new Error('AI Summary request failed');
      const data = await response.json();
      return data.result || "Summary unavailable.";
    } catch (error: any) {
      console.error('AI Summary Error:', error);
      return "AI Summary currently unavailable.";
    }
  },

  async extractBusinessProfile(file: { base64Data: string; mimeType: string }): Promise<any> {
    try {
      const response = await fetch('/api/ai/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file })
      });
      if (!response.ok) throw new Error('AI Extraction request failed');
      return await response.json();
    } catch (error: any) {
      console.error('AI Extraction Error:', error);
      throw new Error(`Failed to extract details: ${error.message || "Unknown error"}`);
    }
  }
};
