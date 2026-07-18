package app.ritim.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(RitimMediaPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
