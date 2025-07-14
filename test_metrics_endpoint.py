#!/usr/bin/env python
"""
Test script for the metrics comparison endpoint
"""

import requests
from pathlib import Path

def test_metrics_endpoint():
    # Path to a test audio file
    recordings_dir = Path(__file__).parent / "recordings"
    test_file = recordings_dir / "tara__chuckle_Hey_I_know_this_is_a_bit_of_a_weird_request_but_laugh_I_really_need_to_get_into_the_server_room_Can_you_let_me_in_.wav"
    
    if not test_file.exists():
        print(f"Test file not found: {test_file}")
        return
    
    # Test the metrics endpoint
    url = "http://127.0.0.1:5001/api/metrics-comparison"
    
    with open(test_file, 'rb') as f1, open(test_file, 'rb') as f2:
        files = {
            'source_audio': ('test1.wav', f1, 'audio/wav'),
            'target_audio': ('test2.wav', f2, 'audio/wav')
        }
        
        try:
            print("Testing metrics comparison endpoint...")
            response = requests.post(url, files=files, timeout=60)
            
            if response.status_code == 200:
                # Save the plot
                with open('test_metrics_plot.png', 'wb') as f:
                    f.write(response.content)
                print("✅ Metrics comparison successful! Plot saved as 'test_metrics_plot.png'")
            else:
                print(f"❌ Error: {response.status_code}")
                print(response.text)
                
        except requests.exceptions.RequestException as e:
            print(f"❌ Request failed: {e}")

if __name__ == "__main__":
    test_metrics_endpoint()
