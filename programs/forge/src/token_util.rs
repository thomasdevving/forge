use crate::constants::TOKEN_PROGRAM_ID;
use crate::error::ForgeError;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, spl_token, CloseAccount, Transfer};

/// Read a classic SPL token account's (mint, owner, amount), checking the token program.
pub fn read_token_account(info: &AccountInfo) -> Result<(Pubkey, Pubkey, u64)> {
    require_keys_eq!(*info.owner, TOKEN_PROGRAM_ID, ForgeError::UnsupportedMint);
    let data = info.try_borrow_data()?;
    let acc = spl_token::state::Account::unpack_from_slice(&data)
        .map_err(|_| error!(ForgeError::UnsupportedMint))?;
    Ok((acc.mint, acc.owner, acc.amount))
}

pub fn amount(info: &AccountInfo) -> Result<u64> {
    Ok(read_token_account(info)?.2)
}

pub fn transfer_from_user<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::transfer(
        CpiContext::new(
            *token_program.key,
            Transfer {
                from: from.clone(),
                to: to.clone(),
                authority: authority.clone(),
            },
        ),
        amount,
    )
}

pub fn transfer_signed<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    signer: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token::transfer(
        CpiContext::new_with_signer(
            *token_program.key,
            Transfer {
                from: from.clone(),
                to: to.clone(),
                authority: authority.clone(),
            },
            signer,
        ),
        amount,
    )
}

pub fn close_signed<'info>(
    token_program: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    signer: &[&[&[u8]]],
) -> Result<()> {
    token::close_account(CpiContext::new_with_signer(
        *token_program.key,
        CloseAccount {
            account: account.clone(),
            destination: destination.clone(),
            authority: authority.clone(),
        },
        signer,
    ))
}

use anchor_lang::solana_program::program_pack::Pack;
