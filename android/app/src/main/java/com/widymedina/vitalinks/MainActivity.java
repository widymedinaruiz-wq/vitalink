package com.widymedina.vitalinks;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.AnimatorSet;
import android.animation.ObjectAnimator;
import android.os.Bundle;
import android.view.View;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        SplashScreen splashScreen = SplashScreen.installSplashScreen(this);
        super.onCreate(savedInstanceState);

        splashScreen.setOnExitAnimationListener(splashScreenView -> {
            View icon = splashScreenView.getIconView();
            ObjectAnimator scaleX = ObjectAnimator.ofFloat(icon, View.SCALE_X, 1f, 1.12f, 0.85f);
            ObjectAnimator scaleY = ObjectAnimator.ofFloat(icon, View.SCALE_Y, 1f, 1.12f, 0.85f);
            ObjectAnimator alpha = ObjectAnimator.ofFloat(icon, View.ALPHA, 1f, 1f, 0f);

            AnimatorSet exit = new AnimatorSet();
            exit.playTogether(scaleX, scaleY, alpha);
            exit.setDuration(350);
            exit.addListener(new AnimatorListenerAdapter() {
                @Override
                public void onAnimationEnd(Animator animation) {
                    splashScreenView.remove();
                }
            });
            exit.start();
        });
    }
}
